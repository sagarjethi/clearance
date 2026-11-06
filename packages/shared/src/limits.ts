import { getAddress, isAddress, namehash, type Address, type Hex } from "viem";

export const RECORD_KEYS = {
  maxSizeUsd: "clearance.maxSizeUsd",
  humanCapUsd: "clearance.humanCapUsd",
  maxImpactBps: "clearance.maxImpactBps",
  requiredVerifiers: "clearance.requiredVerifiers",
  allowedTokens: "clearance.allowedTokens",
  maxPaymentUsd: "clearance.maxPaymentUsd",
  allowedPayees: "clearance.allowedPayees",
  ownerSub: "clearance.ownerSub",
} as const;

export const SCORE_KEY = "clearance.score";

export type Limits = {
  maxSizeUsd: number;
  humanCapUsd: number;
  maxImpactBps: number;
  requiredVerifiers: number;
  allowedTokens: Address[];
  maxPaymentUsd: number;
  allowedPayees: Address[];
  ownerSub: string;
};

export type RawRecords = Record<keyof typeof RECORD_KEYS, string>;

export class LimitsError extends Error {}

function positiveNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0) throw new LimitsError(`${name} is missing or invalid`);
  return value;
}

function addressList(name: string, raw: string): Address[] {
  if (raw.trim() === "") return [];
  return raw.split(",").map((part) => {
    const trimmed = part.trim();
    if (!isAddress(trimmed)) throw new LimitsError(`${name} has an invalid address: ${trimmed}`);
    return getAddress(trimmed);
  });
}

/** A missing or malformed limit throws. Callers treat that as BLOCK, so a bad record can't widen anything. */
export function parseLimits(raw: RawRecords): Limits {
  const requiredVerifiers = positiveNumber("requiredVerifiers", raw.requiredVerifiers);
  if (!Number.isInteger(requiredVerifiers) || requiredVerifiers < 1) {
    throw new LimitsError("requiredVerifiers must be a whole number of at least 1");
  }
  return {
    maxSizeUsd: positiveNumber("maxSizeUsd", raw.maxSizeUsd),
    humanCapUsd: positiveNumber("humanCapUsd", raw.humanCapUsd),
    maxImpactBps: positiveNumber("maxImpactBps", raw.maxImpactBps),
    requiredVerifiers,
    allowedTokens: addressList("allowedTokens", raw.allowedTokens),
    maxPaymentUsd: positiveNumber("maxPaymentUsd", raw.maxPaymentUsd),
    allowedPayees: addressList("allowedPayees", raw.allowedPayees),
    ownerSub: raw.ownerSub,
  };
}

export function agentNode(name: string): Hex {
  return namehash(name);
}
