import type { Evaluation, Limits, Reason, Verdict } from "@clearance/shared";
import type { Address } from "viem";

export const MAX_FACT_AGE_SECONDS = 60;
/** Below this share of the request, a reduced trade isn't worth making, so the verifier blocks instead. */
export const MIN_REDUCTION_BPS = 100n;

export type Sourced<T> = { value: T; source: string; fetchedAt: number } | { error: string; source: string };

export type TokenFacts = {
  address: Address;
  hazards: string[];
};

export type SwapFacts = {
  account: Address;
  limits: Sourced<Limits>;
  allowedHook: Address;
  poolHook: Address;
  tokenIn: Sourced<TokenFacts>;
  tokenOut: Sourced<TokenFacts>;
  stableTokens: Address[];
  amountIn: bigint;
  /** USD value of `amountIn`. */
  sizeUsd: Sourced<number>;
  /** Impact of the full request, in basis points. */
  impactBps: Sourced<number>;
  /** Largest amount in whose impact stays within the limit. */
  safeAmountIn: Sourced<bigint>;
  usdPerRawIn: Sourced<number>;
  humanApproved: boolean;
  humanDetail?: string;
};

export type PaymentFacts = {
  account: Address;
  limits: Sourced<Limits>;
  payee: Address;
  token: Address;
  stableTokens: Address[];
  valueUsd: number;
  validBefore: bigint;
  now: number;
};

export type RuleResult = Pick<Evaluation, "verdict" | "maxAmount" | "reasons">;

function blocked(reasons: Reason[]): RuleResult {
  return { verdict: "BLOCK", maxAmount: "0", reasons };
}

/** Stale or missing data can never come back safe. */
function fresh<T>(fact: Sourced<T>, now: number, name: string, reasons: Reason[]): T | undefined {
  if ("error" in fact) {
    reasons.push({ code: "data_unavailable", severity: "block", detail: `${name}: ${fact.error}`, source: fact.source });
    return undefined;
  }
  if (now - fact.fetchedAt > MAX_FACT_AGE_SECONDS) {
    reasons.push({ code: "data_stale", severity: "block", detail: `${name} is out of date`, source: fact.source });
    return undefined;
  }
  return fact.value;
}

export function evaluateSwap(f: SwapFacts, now: number): RuleResult {
  const reasons: Reason[] = [];
  const limits = fresh(f.limits, now, "owner limits", reasons);
  const tokenIn = fresh(f.tokenIn, now, "input token", reasons);
  const tokenOut = fresh(f.tokenOut, now, "output token", reasons);
  const sizeUsd = fresh(f.sizeUsd, now, "trade size", reasons);
  const impactBps = fresh(f.impactBps, now, "price impact", reasons);
  const safeAmountIn = fresh(f.safeAmountIn, now, "safe size", reasons);
  const usdPerRawIn = fresh(f.usdPerRawIn, now, "input price", reasons);
  if (
    !limits ||
    !tokenIn ||
    !tokenOut ||
    sizeUsd === undefined ||
    impactBps === undefined ||
    safeAmountIn === undefined ||
    usdPerRawIn === undefined
  ) {
    return blocked(reasons);
  }

  if (limits.account !== f.account) {
    reasons.push({
      code: "account_not_bound",
      severity: "block",
      detail: `This name's ENS record binds it to ${limits.account}, not this wallet`,
      source: "ens",
    });
  }
  if (f.amountIn <= 0n) {
    reasons.push({ code: "invalid_amount", severity: "block", detail: "Amount must be above zero" });
  }
  if (f.poolHook !== f.allowedHook) {
    reasons.push({ code: "pool_not_guarded", severity: "block", detail: "This pool isn't guarded by the clearance hook" });
  }
  for (const token of [tokenIn, tokenOut]) {
    if (!limits.allowedTokens.includes(token.address)) {
      reasons.push({
        code: "token_not_allowed",
        severity: "block",
        detail: `${token.address} isn't on the owner's token list`,
        source: "ens",
      });
    }
    if (token.hazards.length > 0 && !f.stableTokens.includes(token.address)) {
      reasons.push({
        code: "token_hazard",
        severity: "block",
        detail: `${token.address} has admin functions: ${token.hazards.join(", ")}`,
        source: "bytecode",
      });
    }
  }
  if (sizeUsd > limits.humanCapUsd) {
    reasons.push({
      code: "above_hard_cap",
      severity: "block",
      detail: `$${sizeUsd.toFixed(2)} is above the owner's hard cap of $${limits.humanCapUsd}`,
      source: "ens",
    });
  }
  if (reasons.some((r) => r.severity === "block")) return blocked(reasons);

  let maxAmount = f.amountIn;
  let verdict: Verdict = "ALLOW";

  if (impactBps > limits.maxImpactBps) {
    if (safeAmountIn * 10_000n < f.amountIn * MIN_REDUCTION_BPS) {
      reasons.push({
        code: "impact_too_high",
        severity: "block",
        detail: `Impact is ${impactBps.toFixed(0)} bps with no workable smaller size`,
        source: "quoter",
      });
      return blocked(reasons);
    }
    maxAmount = safeAmountIn;
    verdict = "REDUCE";
    reasons.push({
      code: "impact_reduced",
      severity: "reduce",
      detail: `Impact is ${impactBps.toFixed(0)} bps against a limit of ${limits.maxImpactBps}, so the size is reduced`,
      source: "quoter",
    });
  }

  const reducedUsd = Number(maxAmount) * usdPerRawIn;
  if (reducedUsd > limits.maxSizeUsd) {
    if (!f.humanApproved) {
      reasons.push({
        code: "human_required",
        severity: "human",
        detail:
          f.humanDetail ??
          `$${reducedUsd.toFixed(2)} is above the owner's $${limits.maxSizeUsd} limit, so a fresh human approval is required`,
        source: "ens",
      });
      return { verdict: "HUMAN_REQUIRED", maxAmount: "0", reasons };
    }
    reasons.push({ code: "human_approved", severity: "info", detail: "The owner approved this exact action", source: "world" });
  }

  if (verdict === "ALLOW") {
    reasons.push({ code: "within_limits", severity: "info", detail: "Within every limit the owner set" });
  }
  return { verdict, maxAmount: maxAmount.toString(), reasons };
}

export function evaluatePayment(f: PaymentFacts, value: bigint): RuleResult {
  const reasons: Reason[] = [];
  const limits = fresh(f.limits, f.now, "owner limits", reasons);
  if (!limits) return blocked(reasons);

  if (limits.account !== f.account) {
    reasons.push({
      code: "account_not_bound",
      severity: "block",
      detail: `This name's ENS record binds it to ${limits.account}, not this wallet`,
      source: "ens",
    });
  }
  if (!f.stableTokens.includes(f.token)) {
    reasons.push({ code: "payment_token_not_allowed", severity: "block", detail: `${f.token} isn't a payment token` });
  }
  if (!limits.allowedPayees.includes(f.payee)) {
    reasons.push({
      code: "payee_not_allowed",
      severity: "block",
      detail: `${f.payee} isn't on the owner's payee list`,
      source: "ens",
    });
  }
  if (f.valueUsd > limits.maxPaymentUsd) {
    reasons.push({
      code: "payment_above_limit",
      severity: "block",
      detail: `$${f.valueUsd.toFixed(2)} is above the owner's $${limits.maxPaymentUsd} payment limit`,
      source: "ens",
    });
  }
  if (f.validBefore - BigInt(f.now) > 600n || f.validBefore <= BigInt(f.now)) {
    reasons.push({
      code: "payment_expiry_invalid",
      severity: "block",
      detail: "A payment authorization must expire within ten minutes",
    });
  }
  if (reasons.length > 0) return blocked(reasons);
  reasons.push({ code: "within_limits", severity: "info", detail: "Allowed payee, within the payment limit" });
  return { verdict: "ALLOW", maxAmount: value.toString(), reasons };
}
