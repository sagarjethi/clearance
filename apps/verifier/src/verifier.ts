import {
  actionHash,
  approvalNonce,
  checkHumanApproval,
  hashCanonical,
  inputsHash,
  paymentClearanceDomain,
  paymentClearanceTypes,
  poolId,
  swapClearanceDomain,
  swapClearanceTypes,
  transferAuthorizationDigest,
  type Action,
  type Evaluation,
  type HumanIssuerConfig,
  type HumanProof,
  type Limits,
  type PaymentAction,
  type SwapAction,
} from "@clearance/shared";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { readLimits, readMarket, readToken } from "./facts";
import { applyReview, reviewAction, type ReviewConfig } from "./review";
import { evaluatePayment, evaluateSwap, type RuleResult, type SwapFacts } from "./rules";

export type VerifierConfig = {
  signer: PrivateKeyAccount;
  client: PublicClient;
  chainId: number;
  hook: Address;
  quoter: Address;
  stateView: Address;
  resolver: Address;
  stableTokens: Address[];
  review: ReviewConfig;
  human?: HumanIssuerConfig;
  maxClearanceSeconds?: number;
};

export type SwapProposal = {
  kind: "swap";
  action: SwapAction;
  maxAmountIn: string;
  expiry: number;
  nonce: string;
  inputsHash: Hex;
};
export type PaymentProposal = { kind: "payment"; action: PaymentAction };
export type Proposal = SwapProposal | PaymentProposal;

type Allowance = { maxAmount: bigint; limitsHash: Hex; expires: number; humanApproval?: string };

export class SignRefused extends Error {}

/** One verifier: evaluates independently, remembers what it allowed, and signs nothing beyond that. */
export class Verifier {
  /** Keyed by action hash. Signing needs a prior evaluation here, so nothing is signed unseen. */
  private allowed = new Map<Hex, Allowance>();
  private seenNonces = new Set<string>();
  /** An approval clears one trade. Without this, one yes could be replayed until it went stale. */
  private usedApprovals = new Set<string>();

  constructor(private config: VerifierConfig) {}

  get address(): Address {
    return this.config.signer.address;
  }

  async evaluate(action: Action, human?: HumanProof): Promise<Evaluation> {
    const { result, evidence, limits, humanApproval } =
      action.kind === "swap" ? await this.evaluateSwapAction(action, human) : await this.evaluatePaymentAction(action);

    const review = await reviewAction(this.config.review, {
      action,
      ruleVerdict: result.verdict,
      reasons: result.reasons,
      evidence,
    });
    const final = applyReview(result, review);
    const now = Math.floor(Date.now() / 1000);
    const hash = actionHash(action);

    if ((final.verdict === "ALLOW" || final.verdict === "REDUCE") && limits) {
      this.allowed.set(hash, {
        maxAmount: BigInt(final.maxAmount),
        limitsHash: hashCanonical(limits),
        expires: now + 120,
        humanApproval,
      });
    } else {
      this.allowed.delete(hash);
    }

    return {
      verifier: this.address,
      verdict: final.verdict,
      maxAmount: final.maxAmount,
      reasons: final.reasons,
      evidenceHash: hashCanonical(evidence),
      review,
      evaluatedAt: now,
    };
  }

  /** Signs only a proposal within this verifier's own evaluation. A nonce is signed once. */
  async sign(proposal: Proposal): Promise<{ signer: Address; signature: Hex }> {
    const allowance = this.allowed.get(actionHash(proposal.action));
    const now = Math.floor(Date.now() / 1000);
    if (!allowance || allowance.expires < now) throw new SignRefused("no current approval for this action");

    if (proposal.kind === "payment") {
      this.allowed.delete(actionHash(proposal.action));
      return { signer: this.address, signature: await this.signPayment(proposal.action) };
    }

    const { action } = proposal;
    const maxAmountIn = BigInt(proposal.maxAmountIn);
    if (maxAmountIn <= 0n || maxAmountIn > allowance.maxAmount) throw new SignRefused("amount is above what this verifier allowed");
    if (maxAmountIn > BigInt(action.amountIn)) throw new SignRefused("amount is above the request");
    const maxSeconds = this.config.maxClearanceSeconds ?? 120;
    if (proposal.expiry <= now || proposal.expiry > now + maxSeconds) throw new SignRefused("expiry is out of range");

    const limits = await readLimits(this.config.client, this.config.resolver, action.agentName);
    if ("error" in limits) throw new SignRefused("limits can't be read");
    if (hashCanonical(limits.value) !== allowance.limitsHash) throw new SignRefused("limits changed since evaluation");
    if (inputsHash(action, limits.value) !== proposal.inputsHash) throw new SignRefused("inputs hash doesn't match");

    const nonceKey = `${action.account}:${proposal.nonce}`;
    if (this.seenNonces.has(nonceKey)) throw new SignRefused("nonce already signed");
    this.seenNonces.add(nonceKey);
    this.allowed.delete(actionHash(action));
    if (allowance.humanApproval) this.usedApprovals.add(allowance.humanApproval);

    const signature = await this.config.signer.signTypedData({
      domain: swapClearanceDomain(this.config.chainId, this.config.hook),
      types: swapClearanceTypes,
      primaryType: "SwapClearance",
      message: {
        agent: action.account,
        poolId: poolId(action.pool),
        zeroForOne: action.zeroForOne,
        maxAmountIn,
        expiry: BigInt(proposal.expiry),
        chainId: BigInt(this.config.chainId),
        nonce: BigInt(proposal.nonce),
        inputsHash: proposal.inputsHash,
      },
    });
    return { signer: this.address, signature };
  }

  private async signPayment(action: PaymentAction): Promise<Hex> {
    const digest = transferAuthorizationDigest(
      this.config.chainId,
      action.token,
      action.tokenName,
      action.tokenVersion,
      action.authorization,
    );
    return this.config.signer.signTypedData({
      domain: paymentClearanceDomain(this.config.chainId, action.account),
      types: paymentClearanceTypes,
      primaryType: "PaymentClearance",
      message: { digest },
    });
  }

  private async checkHuman(action: SwapAction, ownerSub: string, human?: HumanProof) {
    if (!human) return { approved: false };
    if (!this.config.human) return { approved: false, detail: "No human issuer is configured" };
    const approval = approvalNonce(actionHash(action), human.salt);
    if (this.usedApprovals.has(approval)) return { approved: false, detail: "That human approval has already been used" };
    const check = await checkHumanApproval(this.config.human, human.idToken, {
      actionHash: actionHash(action),
      salt: human.salt,
      ownerSub,
    });
    return check.ok ? { approved: true, approval } : { approved: false, detail: `Human approval refused: ${check.reason}` };
  }

  private async evaluateSwapAction(action: SwapAction, human?: HumanProof) {
    const { client, resolver, quoter, stateView, stableTokens, hook } = this.config;
    const limits = await readLimits(client, resolver, action.agentName);
    const amountIn = BigInt(action.amountIn);
    const tokenInAddress = action.zeroForOne ? action.pool.currency0 : action.pool.currency1;
    const tokenOutAddress = action.zeroForOne ? action.pool.currency1 : action.pool.currency0;

    const [tokenIn, tokenOut, market, humanCheck] = await Promise.all([
      readToken(client, tokenInAddress),
      readToken(client, tokenOutAddress),
      readMarket(
        client,
        { quoter, stateView },
        action.pool,
        action.zeroForOne,
        amountIn,
        "error" in limits ? undefined : limits.value.maxImpactBps,
        stableTokens,
      ),
      "error" in limits ? { approved: false } : this.checkHuman(action, limits.value.ownerSub, human),
    ]);

    const facts: SwapFacts = {
      limits,
      allowedHook: getAddress(hook),
      poolHook: getAddress(action.pool.hooks),
      tokenIn,
      tokenOut,
      stableTokens,
      amountIn,
      sizeUsd: market.sizeUsd,
      impactBps: market.impactBps,
      safeAmountIn: market.safeAmountIn,
      usdPerRawIn: market.usdPerRawIn,
      humanApproved: humanCheck.approved,
      humanDetail: "detail" in humanCheck ? humanCheck.detail : undefined,
    };
    const now = Math.floor(Date.now() / 1000);
    const result: RuleResult = evaluateSwap(facts, now);
    const clearedLimits: Limits | undefined = "error" in limits ? undefined : limits.value;
    const humanApproval = "approval" in humanCheck ? humanCheck.approval : undefined;
    return { result, evidence: facts, limits: clearedLimits, humanApproval };
  }

  private async evaluatePaymentAction(action: PaymentAction) {
    const { client, resolver, stableTokens } = this.config;
    const limits = await readLimits(client, resolver, action.agentName);
    const value = BigInt(action.authorization.value);
    const now = Math.floor(Date.now() / 1000);
    const blocked: RuleResult | undefined =
      action.authorization.from !== action.account
        ? {
            verdict: "BLOCK",
            maxAmount: "0",
            reasons: [{ code: "payer_mismatch", severity: "block", detail: "The payer isn't this agent's account" }],
          }
        : undefined;
    const facts = {
      limits,
      payee: action.authorization.to,
      token: action.token,
      stableTokens,
      // Payment tokens are stablecoins with six decimals, which evaluatePayment confirms by allowlist.
      valueUsd: Number(value) / 1e6,
      validBefore: BigInt(action.authorization.validBefore),
      now,
    };
    const result = blocked ?? evaluatePayment(facts, value);
    const clearedLimits: Limits | undefined = "error" in limits ? undefined : limits.value;
    return { result, evidence: facts, limits: clearedLimits, humanApproval: undefined };
  }
}
