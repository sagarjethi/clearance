import {
  LATEST_BLOCK_NUMBER,
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  ok,
  text,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { encodeAttestationReport, evaluateAttestation, type ClearanceRecord } from "../../packages/shared/src/attestation";
import type { SwapAction } from "../../packages/shared/src/actions";
import { agentNode, parseLimits, RECORD_KEYS, type RawRecords } from "../../packages/shared/src/limits";

export type Config = {
  schedule: string;
  apiUrl: string;
  chainSelectorName: string;
  chainId: number;
  gasLimit: string;
  resolver: Address;
  verifierSet: Address;
  quoter: Address;
  stateView: Address;
  ledger: Address;
};

type Proof = {
  id: string;
  action: SwapAction;
  clearance?: ClearanceRecord;
  signatures?: Hex[];
  digest?: Hex;
};

const resolverAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const verifierSetAbi = parseAbi(["function hasQuorum(bytes32 digest, bytes[] signatures) view returns (bool)"]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const Q192 = 2n ** 192n;

function evmClient(config: Config) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`Unknown chain ${config.chainSelectorName}`);
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
}

function read<const TAbi extends Abi>(
  runtime: Runtime<Config>,
  client: ReturnType<typeof evmClient>,
  to: Address,
  abi: TAbi,
  functionName: string,
  args: readonly unknown[],
): unknown {
  const data = encodeFunctionData({ abi: abi as Abi, functionName, args });
  const reply = client
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to, data }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  return decodeFunctionResult({ abi: abi as Abi, functionName, data: bytesToHex(reply.data) });
}

function fetchText(runtime: Runtime<Config>, url: string): string {
  const http = new cre.capabilities.HTTPClient();
  return http
    .sendRequest(
      runtime,
      (sender, target: string) => {
        const response = sender.sendRequest({ url: target, method: "GET" }).result();
        if (!ok(response)) throw new Error(`${target} returned ${response.statusCode}`);
        return text(response);
      },
      consensusIdenticalAggregation<string>(),
    )(url)
    .result();
}

/** Every node re-derives the facts from the chain. The API only supplies what to check. */
export function attestDecision(runtime: Runtime<Config>, decisionId: string): string {
  const config = runtime.config;
  const proof = JSON.parse(fetchText(runtime, `${config.apiUrl}/v1/proofs/${decisionId}`)) as Proof;
  if (proof.action.kind !== "swap" || !proof.clearance || !proof.signatures || !proof.digest) {
    runtime.log(`Decision ${decisionId} has no clearance to attest`);
    return "nothing to attest";
  }
  const client = evmClient(config);

  const node = agentNode(proof.action.agentName);
  const records = Object.fromEntries(
    Object.entries(RECORD_KEYS).map(([field, key]) => [
      field,
      read(runtime, client, config.resolver, resolverAbi, "text", [node, key]) as string,
    ]),
  ) as RawRecords;
  const limits = parseLimits(records);

  const quorum = read(runtime, client, config.verifierSet, verifierSetAbi, "hasQuorum", [proof.digest, proof.signatures]) as boolean;

  let impactBps: number | undefined;
  try {
    const slot0 = read(runtime, client, config.stateView, stateViewAbi, "getSlot0", [proof.clearance.poolId]) as readonly [bigint, ...unknown[]];
    const amountIn = BigInt(proof.clearance.maxAmountIn);
    const quote = read(runtime, client, config.quoter, quoterAbi, "quoteExactInputSingle", [
      { poolKey: proof.action.pool, zeroForOne: proof.action.zeroForOne, exactAmount: amountIn, hookData: "0x" },
    ]) as readonly [bigint, bigint];
    const price = slot0[0] * slot0[0];
    const ideal = proof.action.zeroForOne ? (amountIn * price) / Q192 : (amountIn * Q192) / price;
    impactBps = ideal === 0n ? undefined : quote[0] >= ideal ? 0 : Number(((ideal - quote[0]) * 10_000n) / ideal);
  } catch (error) {
    runtime.log(`Market re-check failed: ${(error as Error).message}`);
  }

  const result = evaluateAttestation({
    action: proof.action,
    clearance: proof.clearance,
    limits,
    quorum,
    impactBps,
    now: Math.floor(runtime.now().getTime() / 1000),
    chainId: config.chainId,
  });
  runtime.log(`Decision ${decisionId}: status ${result.status}. ${result.problems.join("; ") || "All checks passed"}`);

  const payload = encodeAttestationReport(proof.digest, result, proof.clearance.inputsHash);
  const report = runtime
    .report({
      encodedPayload: hexToBase64(payload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  const write = client
    .writeReport(runtime, {
      receiver: config.ledger,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result();
  const txHash = write.txHash ? bytesToHex(write.txHash) : "none";
  runtime.log(`Report written in ${txHash}`);
  return txHash;
}

/** The scheduled path: finds the oldest clearance still waiting for a check, so none get missed. */
export function attestNextPending(runtime: Runtime<Config>): string {
  const pending = JSON.parse(fetchText(runtime, `${runtime.config.apiUrl}/v1/attestations/pending`)) as { ids: string[] };
  const next = pending.ids[0];
  if (!next) {
    runtime.log("No clearances are waiting");
    return "idle";
  }
  return attestDecision(runtime, next);
}
