import { describe, expect, it } from "vitest";
import { actionHash, canonicalJson } from "./canonical";
import { LimitsError, parseLimits, type RawRecords } from "./limits";
import { sortBySigner } from "./eip712";

const raw: RawRecords = {
  account: "0x0000000000000000000000000000000000000009",
  maxSizeUsd: "1000",
  humanCapUsd: "25000",
  maxImpactBps: "300",
  requiredVerifiers: "2",
  allowedTokens: "0x0000000000000000000000000000000000000001",
  maxPaymentUsd: "1",
  allowedPayees: "",
  ownerSub: "owner",
};

describe("parseLimits fails closed", () => {
  it("parses valid records", () => {
    expect(parseLimits(raw).requiredVerifiers).toBe(2);
  });
  it.each(["maxSizeUsd", "humanCapUsd", "maxImpactBps", "requiredVerifiers", "maxPaymentUsd"] as const)(
    "rejects an empty %s",
    (key) => {
      expect(() => parseLimits({ ...raw, [key]: "" })).toThrow(LimitsError);
    },
  );
  it("rejects text where a number belongs", () => {
    expect(() => parseLimits({ ...raw, maxSizeUsd: "lots" })).toThrow(LimitsError);
  });
  it("rejects a negative number", () => {
    expect(() => parseLimits({ ...raw, maxSizeUsd: "-1" })).toThrow(LimitsError);
  });
  it("rejects infinity", () => {
    expect(() => parseLimits({ ...raw, maxSizeUsd: "Infinity" })).toThrow(LimitsError);
  });
  it("rejects zero required verifiers", () => {
    expect(() => parseLimits({ ...raw, requiredVerifiers: "0" })).toThrow(LimitsError);
  });
  it("rejects a missing account binding", () => {
    expect(() => parseLimits({ ...raw, account: "" })).toThrow(LimitsError);
  });
  it("rejects a bad address", () => {
    expect(() => parseLimits({ ...raw, allowedTokens: "0xnope" })).toThrow(LimitsError);
  });
});

describe("canonical hashing", () => {
  it("doesn't depend on key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it("leaves the agent's reason out of the action hash", () => {
    const base = {
      kind: "swap" as const,
      agentName: "a.eth",
      account: "0x0000000000000000000000000000000000000001" as const,
      pool: {
        currency0: "0x0000000000000000000000000000000000000002" as const,
        currency1: "0x0000000000000000000000000000000000000003" as const,
        fee: 3000,
        tickSpacing: 60,
        hooks: "0x0000000000000000000000000000000000000004" as const,
      },
      zeroForOne: true,
      amountIn: "1",
    };
    expect(actionHash({ ...base, reason: "one" })).toBe(actionHash({ ...base, reason: "two" }));
    expect(actionHash(base)).not.toBe(actionHash({ ...base, amountIn: "2" }));
  });
});

it("sorts signatures numerically by signer", () => {
  const sorted = sortBySigner([
    { signer: "0xF000000000000000000000000000000000000000", signature: "0x02" },
    { signer: "0x0a00000000000000000000000000000000000000", signature: "0x01" },
  ]);
  expect(sorted).toEqual(["0x01", "0x02"]);
});
