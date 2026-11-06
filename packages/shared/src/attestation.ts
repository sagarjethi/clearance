import { encodeAbiParameters, isAddressEqual, type Address, type Hex } from "viem";
import type { SwapAction } from "./actions";
import { inputsHash } from "./canonical";
import { poolId } from "./eip712";
import type { Limits } from "./limits";

export const ATTESTED = 1;
export const REFUSED = 2;

export const ledgerAbi = [
  {
    type: "function",
    name: "attestations",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "at", type: "uint64" },
      { name: "impactBps", type: "uint32" },
      { name: "inputsHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "onReport",
    stateMutability: "nonpayable",
    inputs: [
      { name: "metadata", type: "bytes" },
      { name: "report", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export type ClearanceRecord = {
  agent: Address;
  poolId: Hex;
  zeroForOne: boolean;
  maxAmountIn: string;
  expiry: number;
  chainId: number;
  nonce: string;
  inputsHash: Hex;
};

export type AttestationInput = {
  action: SwapAction;
  clearance: ClearanceRecord;
  /** Read from the chain by the attestor, not taken from the API. */
  limits: Limits;
  /** The chain's own answer to VerifierSet.hasQuorum for these signatures. */
  quorum: boolean;
  /** Re-quoted by the attestor at the cleared size. Undefined when the quote failed. */
  impactBps: number | undefined;
  now: number;
  chainId: number;
};

export type AttestationResult = { status: typeof ATTESTED | typeof REFUSED; problems: string[]; impactBps: number };

/** An independent second look at a clearance. It trusts nothing the API says about limits or market. */
export function evaluateAttestation(input: AttestationInput): AttestationResult {
  const { action, clearance, limits } = input;
  const problems: string[] = [];
  if (!isAddressEqual(clearance.agent, action.account)) problems.push("Clearance agent isn't the action's account");
  if (!isAddressEqual(limits.account, action.account)) problems.push("ENS record binds this name to another account");
  if (clearance.poolId !== poolId(action.pool)) problems.push("Clearance pool isn't the action's pool");
  if (clearance.zeroForOne !== action.zeroForOne) problems.push("Clearance direction isn't the action's direction");
  if (clearance.chainId !== input.chainId) problems.push("Clearance is for another chain");
  if (clearance.expiry <= input.now) problems.push("Clearance has expired");
  if (BigInt(clearance.maxAmountIn) > BigInt(action.amountIn)) problems.push("Cleared amount is above the request");
  if (clearance.inputsHash !== inputsHash(action, limits)) problems.push("Owner limits changed since the clearance");
  if (!input.quorum) problems.push("Signatures don't reach quorum on the chain");
  if (input.impactBps === undefined) problems.push("Market re-check failed");
  else if (input.impactBps > limits.maxImpactBps) {
    problems.push(`Price impact is now ${input.impactBps} bps against a limit of ${limits.maxImpactBps}`);
  }
  return { status: problems.length === 0 ? ATTESTED : REFUSED, problems, impactBps: input.impactBps ?? 0 };
}

export function encodeAttestationReport(digest: Hex, result: AttestationResult, clearanceInputsHash: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "uint32" }, { type: "bytes32" }],
    [digest, result.status, Math.min(result.impactBps, 2 ** 32 - 1), clearanceInputsHash],
  );
}
