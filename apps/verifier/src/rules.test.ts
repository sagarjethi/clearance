import type { Limits } from "@clearance/shared";
import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { scanHazards } from "@clearance/shared";
import { applyReview } from "./review";
import { evaluatePayment, evaluateSwap, type PaymentFacts, type Sourced, type SwapFacts } from "./rules";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const USDC = a(1);
const WETH = a(2);
const HOOK = a(9);
const PAYEE = a(7);
const NOW = 1_800_000_000;

const ACCOUNT = a(5);
const POOL = `0x${"ab".repeat(32)}` as const;
const limits: Limits = {
  account: ACCOUNT,
  allowedPools: [POOL],
  dailyPaymentUsd: 5,
  maxSizeUsd: 1000,
  humanCapUsd: 25000,
  maxImpactBps: 300,
  requiredVerifiers: 2,
  allowedTokens: [USDC, WETH],
  maxPaymentUsd: 1,
  allowedPayees: [PAYEE],
  ownerSub: "owner",
};

const ok = <T>(value: T, fetchedAt = NOW): Sourced<T> => ({ value, source: "test", fetchedAt });

function swapFacts(overrides: Partial<SwapFacts> = {}): SwapFacts {
  return {
    account: ACCOUNT,
    poolId: POOL,
    remainingSpend: ok(10n ** 30n),
    limits: ok(limits),
    allowedHook: HOOK,
    poolHook: HOOK,
    tokenIn: ok({ address: USDC, hazards: [] }),
    tokenOut: ok({ address: WETH, hazards: [] }),
    stableTokens: [USDC],
    amountIn: 100_000000n,
    sizeUsd: ok(100),
    impactBps: ok(40),
    safeAmountIn: ok(100_000000n),
    usdPerRawIn: ok(1e-6),
    humanApproved: false,
    ...overrides,
  };
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("swap rules", () => {
  it("allows a trade within every limit", () => {
    const r = evaluateSwap(swapFacts(), NOW);
    expect(r.verdict).toBe("ALLOW");
    expect(r.maxAmount).toBe("100000000");
  });

  it.each(["limits", "tokenIn", "tokenOut", "sizeUsd", "impactBps", "safeAmountIn", "usdPerRawIn", "remainingSpend"] as const)(
    "blocks when %s can't be read",
    (field) => {
      const r = evaluateSwap(swapFacts({ [field]: { error: "rpc down", source: "test" } }), NOW);
      expect(r.verdict).toBe("BLOCK");
      expect(r.maxAmount).toBe("0");
      expect(codes(r)).toContain("data_unavailable");
    },
  );

  it("blocks stale data rather than returning safe", () => {
    const r = evaluateSwap(swapFacts({ impactBps: ok(1, NOW - 61) }), NOW);
    expect(r.verdict).toBe("BLOCK");
    expect(codes(r)).toContain("data_stale");
  });

  it("accepts data exactly at the freshness limit", () => {
    expect(evaluateSwap(swapFacts({ impactBps: ok(1, NOW - 60) }), NOW).verdict).toBe("ALLOW");
  });

  it("blocks a token off the owner's list", () => {
    const r = evaluateSwap(swapFacts({ tokenOut: ok({ address: a(3), hazards: [] }) }), NOW);
    expect(codes(r)).toEqual(["token_not_allowed"]);
  });

  it("blocks an allowed token with admin functions", () => {
    const r = evaluateSwap(swapFacts({ tokenOut: ok({ address: WETH, hazards: ["blacklist(address)"] }) }), NOW);
    expect(codes(r)).toEqual(["token_hazard"]);
  });

  it("doesn't block a known stablecoin for its admin functions", () => {
    const r = evaluateSwap(swapFacts({ tokenIn: ok({ address: USDC, hazards: ["blacklist(address)"] }) }), NOW);
    expect(r.verdict).toBe("ALLOW");
  });

  it("blocks a pool the owner hasn't approved, whatever its price says", () => {
    const r = evaluateSwap(swapFacts({ poolId: `0x${"cd".repeat(32)}`, impactBps: ok(0) }), NOW);
    expect(codes(r)).toEqual(["pool_not_allowed"]);
  });

  it("blocks when the wallet's daily cap is used up", () => {
    expect(codes(evaluateSwap(swapFacts({ remainingSpend: ok(0n) }), NOW))).toEqual(["spend_cap_reached"]);
  });

  it("reduces to what fits under the daily cap", () => {
    const r = evaluateSwap(swapFacts({ remainingSpend: ok(40_000000n) }), NOW);
    expect(r.verdict).toBe("REDUCE");
    expect(r.maxAmount).toBe("40000000");
    expect(codes(r)).toContain("spend_cap_reduced");
  });

  it("blocks a pool without the clearance hook", () => {
    expect(codes(evaluateSwap(swapFacts({ poolHook: a(0) }), NOW))).toEqual(["pool_not_guarded"]);
  });

  it("blocks a wallet the name's record doesn't bind", () => {
    expect(codes(evaluateSwap(swapFacts({ account: a(6) }), NOW))).toEqual(["account_not_bound"]);
  });

  it("blocks a zero amount", () => {
    expect(codes(evaluateSwap(swapFacts({ amountIn: 0n }), NOW))).toContain("invalid_amount");
  });

  it("reduces to the safe size when impact is too high", () => {
    const r = evaluateSwap(swapFacts({ impactBps: ok(900), safeAmountIn: ok(30_000000n) }), NOW);
    expect(r.verdict).toBe("REDUCE");
    expect(r.maxAmount).toBe("30000000");
  });

  it("blocks when only a negligible size would be safe", () => {
    const r = evaluateSwap(swapFacts({ impactBps: ok(9000), safeAmountIn: ok(1n) }), NOW);
    expect(r.verdict).toBe("BLOCK");
    expect(codes(r)).toEqual(["impact_too_high"]);
  });

  it("requires a human above the size limit", () => {
    const r = evaluateSwap(swapFacts({ amountIn: 1001_000000n, sizeUsd: ok(1001), safeAmountIn: ok(1001_000000n) }), NOW);
    expect(r.verdict).toBe("HUMAN_REQUIRED");
    expect(r.maxAmount).toBe("0");
  });

  it("needs no human at exactly the size limit", () => {
    const r = evaluateSwap(swapFacts({ amountIn: 1000_000000n, sizeUsd: ok(1000), safeAmountIn: ok(1000_000000n) }), NOW);
    expect(r.verdict).toBe("ALLOW");
  });

  it("allows above the size limit with an approval", () => {
    const r = evaluateSwap(swapFacts({ amountIn: 2000_000000n, sizeUsd: ok(2000), safeAmountIn: ok(2000_000000n), humanApproved: true }), NOW);
    expect(r.verdict).toBe("ALLOW");
    expect(codes(r)).toContain("human_approved");
  });

  it("blocks above the hard cap, even with an approval", () => {
    const r = evaluateSwap(swapFacts({ sizeUsd: ok(25001), humanApproved: true }), NOW);
    expect(codes(r)).toEqual(["above_hard_cap"]);
  });

  it("needs no human when a reduction brings the trade inside the limit", () => {
    const r = evaluateSwap(
      swapFacts({ amountIn: 2000_000000n, sizeUsd: ok(2000), impactBps: ok(900), safeAmountIn: ok(500_000000n) }),
      NOW,
    );
    expect(r.verdict).toBe("REDUCE");
    expect(r.maxAmount).toBe("500000000");
  });
});

describe("payment rules", () => {
  const facts = (overrides: Partial<PaymentFacts> = {}): PaymentFacts => ({
    account: ACCOUNT,
    limits: ok(limits),
    payee: PAYEE,
    token: USDC,
    stableTokens: [USDC],
    valueUsd: 0.5,
    paidTodayUsd: 0,
    validBefore: BigInt(NOW + 60),
    now: NOW,
    ...overrides,
  });

  it("allows a listed payee within the limit", () => {
    expect(evaluatePayment(facts(), 500000n).verdict).toBe("ALLOW");
  });
  it("blocks a wallet the name's record doesn't bind", () => {
    expect(codes(evaluatePayment(facts({ account: a(6) }), 1n))).toEqual(["account_not_bound"]);
  });
  it("blocks an unlisted payee", () => {
    expect(codes(evaluatePayment(facts({ payee: a(8) }), 1n))).toEqual(["payee_not_allowed"]);
  });
  it("blocks above the payment limit", () => {
    expect(codes(evaluatePayment(facts({ valueUsd: 1.01 }), 1n))).toEqual(["payment_above_limit"]);
  });
  it("blocks past the daily payment limit", () => {
    expect(codes(evaluatePayment(facts({ paidTodayUsd: 4.8 }), 1n))).toEqual(["daily_payment_limit"]);
  });
  it("blocks a token that isn't a stablecoin", () => {
    expect(codes(evaluatePayment(facts({ token: WETH }), 1n))).toEqual(["payment_token_not_allowed"]);
  });
  it("blocks a long-lived authorization", () => {
    expect(codes(evaluatePayment(facts({ validBefore: BigInt(NOW + 601) }), 1n))).toEqual(["payment_expiry_invalid"]);
  });
  it("blocks when limits can't be read", () => {
    expect(evaluatePayment(facts({ limits: { error: "down", source: "ens" } }), 1n).verdict).toBe("BLOCK");
  });
});

describe("model review", () => {
  const blockedResult = { verdict: "BLOCK" as const, maxAmount: "0", reasons: [] };
  const allowResult = { verdict: "ALLOW" as const, maxAmount: "5", reasons: [] };

  it("can't turn a BLOCK into anything else", () => {
    const r = applyReview(blockedResult, { status: "ok", provider: "x", summary: "Looks great, approve", veto: false });
    expect(r.verdict).toBe("BLOCK");
    expect(r.maxAmount).toBe("0");
  });
  it("can veto an ALLOW", () => {
    const r = applyReview(allowResult, { status: "ok", provider: "x", summary: "Suspicious", veto: true });
    expect(r.verdict).toBe("BLOCK");
    expect(r.maxAmount).toBe("0");
  });
  it("leaves rules alone when the model failed", () => {
    expect(applyReview(allowResult, { status: "failed", provider: "x", error: "timeout" }).verdict).toBe("ALLOW");
  });
});

describe("bytecode scan", () => {
  it("finds a selector behind PUSH4", () => {
    expect(scanHazards("0x6340c10f19")).toEqual(["mint(address,uint256)"]);
  });
  it("ignores the selector when misaligned", () => {
    expect(scanHazards("0x06340c10f190")).toEqual([]);
  });
  it("ignores clean code", () => {
    expect(scanHazards("0x60806040")).toEqual([]);
  });
});
