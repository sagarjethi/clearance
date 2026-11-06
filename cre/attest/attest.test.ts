import { describe, expect } from "bun:test";
import { bytesToHex, getNetwork } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, parseAbi, toBytes, type Hex } from "viem";
import { attestDecision, attestNextPending, type Config } from "./attest";
import { inputsHash } from "../../packages/shared/src/canonical";
import { poolId } from "../../packages/shared/src/eip712";
import { parseLimits, type RawRecords } from "../../packages/shared/src/limits";
import type { SwapAction } from "../../packages/shared/src/actions";

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const records: RawRecords = {
  account: ACCOUNT,
  maxSizeUsd: "1000",
  humanCapUsd: "25000",
  maxImpactBps: "300",
  requiredVerifiers: "2",
  allowedTokens: "",
  maxPaymentUsd: "1",
  allowedPayees: "",
  ownerSub: "owner",
};
const FIELD_BY_KEY = Object.fromEntries(Object.keys(records).map((f) => [`clearance.${f}`, f]));

const config: Config = {
  schedule: "0 * * * * *",
  apiUrl: "https://api.test",
  chainSelectorName: "ethereum-testnet-sepolia",
  chainId: 11155111,
  gasLimit: "500000",
  resolver: "0x00000000000000000000000000000000000000b1",
  verifierSet: "0x00000000000000000000000000000000000000b2",
  quoter: "0x00000000000000000000000000000000000000b3",
  stateView: "0x00000000000000000000000000000000000000b4",
  ledger: "0x00000000000000000000000000000000000000b5",
};

const action: SwapAction = {
  kind: "swap",
  agentName: "alice.agents.clearance.eth",
  account: ACCOUNT,
  pool: {
    currency0: "0x00000000000000000000000000000000000000c1",
    currency1: "0x00000000000000000000000000000000000000c2",
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x00000000000000000000000000000000000000c3",
  },
  zeroForOne: true,
  amountIn: "1000000",
};

function proofFor(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    action,
    digest: `0x${"ab".repeat(32)}`,
    signatures: [`0x${"11".repeat(65)}`, `0x${"22".repeat(65)}`],
    clearance: {
      agent: ACCOUNT,
      poolId: poolId(action.pool),
      zeroForOne: true,
      maxAmountIn: "1000000",
      expiry: Math.floor(Date.now() / 1000) + 60,
      chainId: 11155111,
      nonce: "1",
      inputsHash: inputsHash(action, parseLimits(records)),
    },
    ...overrides,
  };
}

const allAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function hasQuorum(bytes32 digest, bytes[] signatures) view returns (bool)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

type World = { quorum?: boolean; quoteOut?: bigint; quoteFails?: boolean; records?: RawRecords; proof?: unknown; pending?: string[] };

function setup(world: World) {
  const selector = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true })!.chainSelector.selector;
  const evm = EvmMock.testInstance(selector);
  let written: Hex | undefined;
  let receiver: Hex | undefined;
  evm.callContract = (req: any) => {
    const data = bytesToHex(req.call.data) as Hex;
    const decoded = decodeFunctionData({ abi: allAbi, data });
    let result: Hex;
    if (decoded.functionName === "text") {
      const key = decoded.args[1] as string;
      result = encodeFunctionResult({ abi: allAbi, functionName: "text", result: (world.records ?? records)[FIELD_BY_KEY[key] as keyof RawRecords] });
    } else if (decoded.functionName === "hasQuorum") {
      result = encodeFunctionResult({ abi: allAbi, functionName: "hasQuorum", result: world.quorum ?? true });
    } else if (decoded.functionName === "getSlot0") {
      result = encodeFunctionResult({ abi: allAbi, functionName: "getSlot0", result: [2n ** 96n, 0, 0, 3000] });
    } else {
      if (world.quoteFails) throw new Error("quote reverted");
      result = encodeFunctionResult({ abi: allAbi, functionName: "quoteExactInputSingle", result: [world.quoteOut ?? 995_000n, 1n] });
    }
    return { data: toBytes(result) };
  };
  evm.writeReport = (req: any) => {
    receiver = bytesToHex(req.receiver) as Hex;
    written = bytesToHex(req.report.rawReport) as Hex;
    return { txStatus: "TX_STATUS_SUCCESS", txHash: toBytes(`0x${"cd".repeat(32)}`) } as any;
  };
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req: any) => {
    const body = req.url.endsWith("/pending") ? { ids: world.pending ?? [] } : (world.proof ?? proofFor());
    return { statusCode: 200, body: new TextEncoder().encode(JSON.stringify(body)), headers: {} } as any;
  };
  return { written: () => written, receiver: () => receiver };
}

/** The report's payload follows CRE's fixed metadata header, or stands alone in the test runtime. */
function statusOf(raw: Hex): number {
  const [, status] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "uint32" }, { type: "bytes32" }],
    `0x${raw.slice(-256)}` as Hex,
  );
  return status;
}

describe("attest workflow", () => {
  test("attests a clearance when limits, quorum and market all check out", () => {
    const m = setup({});
    const runtime = newTestRuntime({ config } as never) as any;
    runtime.config = config;
    expect(attestDecision(runtime, "d1")).toBe(`0x${"cd".repeat(32)}`);
    expect(statusOf(m.written()!)).toBe(1);
    expect(m.receiver()!.toLowerCase()).toBe(config.ledger.toLowerCase());
  });

  test("refuses when the chain says there is no quorum", () => {
    const m = setup({ quorum: false });
    const runtime = newTestRuntime({ config } as never) as any;
    runtime.config = config;
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses when the owner changed a limit since the clearance", () => {
    const m = setup({ records: { ...records, maxSizeUsd: "5" } });
    const runtime = newTestRuntime({ config } as never) as any;
    runtime.config = config;
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses when the market moved past the limit", () => {
    const m = setup({ quoteOut: 900_000n });
    const runtime = newTestRuntime({ config } as never) as any;
    runtime.config = config;
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses when the market can't be re-checked", () => {
    const m = setup({ quoteFails: true });
    const runtime = newTestRuntime({ config } as never) as any;
    runtime.config = config;
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("writes nothing for a decision with no clearance", () => {
    const m = setup({ proof: { id: "d2", action } });
    const runtime = newTestRuntime({ config } as never) as any;
    runtime.config = config;
    expect(attestDecision(runtime, "d2")).toBe("nothing to attest");
    expect(m.written()).toBeUndefined();
  });

  test("the scheduled path takes the next pending decision, and idles when there is none", () => {
    const m = setup({ pending: ["d1"] });
    const runtime = newTestRuntime({ config } as never) as any;
    runtime.config = config;
    expect(attestNextPending(runtime)).toBe(`0x${"cd".repeat(32)}`);
    expect(statusOf(m.written()!)).toBe(1);

    setup({ pending: [] });
    expect(attestNextPending(runtime)).toBe("idle");
  });
});
