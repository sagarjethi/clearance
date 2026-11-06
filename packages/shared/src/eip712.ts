import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hashTypedData,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import type { Authorization, PoolKey } from "./actions";

export type SwapClearance = {
  agent: Address;
  poolId: Hex;
  zeroForOne: boolean;
  maxAmountIn: bigint;
  minAmountOut: bigint;
  expiry: bigint;
  chainId: bigint;
  nonce: bigint;
  inputsHash: Hex;
};

export const swapClearanceTypes = {
  SwapClearance: [
    { name: "agent", type: "address" },
    { name: "poolId", type: "bytes32" },
    { name: "zeroForOne", type: "bool" },
    { name: "maxAmountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "chainId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "inputsHash", type: "bytes32" },
  ],
} as const;

export function swapClearanceDomain(chainId: number, hook: Address) {
  return { name: "Clearance", version: "1", chainId, verifyingContract: hook } as const;
}

export const paymentClearanceTypes = {
  PaymentClearance: [{ name: "digest", type: "bytes32" }],
} as const;

export function paymentClearanceDomain(chainId: number, account: Address) {
  return { name: "ClearanceAccount", version: "1", chainId, verifyingContract: account } as const;
}

export const transferAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function transferAuthorizationDigest(
  chainId: number,
  token: Address,
  tokenName: string,
  tokenVersion: string,
  a: Authorization,
): Hex {
  return hashTypedData({
    domain: { name: tokenName, version: tokenVersion, chainId, verifyingContract: token },
    types: transferAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  });
}

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const clearanceAbiType = {
  type: "tuple",
  components: swapClearanceTypes.SwapClearance,
} as const;

export function encodeHookData(clearance: SwapClearance, signatures: readonly Hex[]): Hex {
  return encodeAbiParameters([clearanceAbiType, { type: "bytes[]" }], [clearance, signatures]);
}

export type SignedBy = { signer: Address; signature: Hex };

/** The contracts require signatures in ascending signer order, which rules out duplicates. */
export function sortBySigner(signed: readonly SignedBy[]): Hex[] {
  return [...signed]
    .sort((a, b) => {
      const x = BigInt(getAddress(a.signer));
      const y = BigInt(getAddress(b.signer));
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((s) => s.signature);
}

/** ERC-1271 format ClearanceAccount expects: agent signature, then verifier signatures in signer order. */
export function packPaymentSignature(agentSignature: Hex, verifiers: readonly SignedBy[]): Hex {
  const parts = [agentSignature, ...sortBySigner(verifiers)];
  return encodePacked(parts.map(() => "bytes" as const), parts);
}
