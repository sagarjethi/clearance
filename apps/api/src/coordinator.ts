import {
  encodeHookData,
  actionHash,
  inputsHash,
  poolId,
  sortBySigner,
  verifierSetAbi,
  type Action,
  type Evaluation,
  type HumanProof,
  type Limits,
  type SignedBy,
  type SwapClearance,
  type Verdict,
} from "@clearance/shared";
import { randomBytes } from "node:crypto";
import type { Address, Hex, PublicClient } from "viem";

export type Decision = {
  id: string;
  verdict: Verdict;
  action: Action;
  actionHash: Hex;
  requested: string;
  required: number;
  evaluations: Evaluation[];
  unreachable: string[];
  clearance?: {
    agent: Address;
    poolId: Hex;
    zeroForOne: boolean;
    maxAmountIn: string;
    expiry: number;
    chainId: number;
    nonce: string;
    inputsHash: Hex;
  };
  signatures?: Hex[];
  verifierSignatures?: SignedBy[];
  hookData?: Hex;
  decidedAt: number;
};

const CLEARANCE_SECONDS = 90;

export type CoordinatorConfig = {
  verifierUrls: string[];
  client: PublicClient;
  chainId: number;
  verifierSet: Address;
  readLimits: (name: string) => Promise<Limits | undefined>;
  timeoutMs?: number;
};

async function post<T>(url: string, body: unknown, timeoutMs: number): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) return { ok: false, error: data.error ?? `status ${response.status}` };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Collects independent evaluations and proposes one clearance. It holds no keys and can't approve
 * anything: each verifier re-checks the proposal against its own evaluation before signing.
 */
export class Coordinator {
  constructor(private config: CoordinatorConfig) {}

  async decide(action: Action, human?: HumanProof): Promise<Decision> {
    const { verifierUrls, timeoutMs = 30_000 } = this.config;
    const results = await Promise.all(
      verifierUrls.map((url) => post<Evaluation>(`${url}/evaluate`, { action, human }, timeoutMs).then((r) => ({ url, r }))),
    );
    const evaluations = results.flatMap(({ r }) => (r.ok ? [r.data] : []));
    const unreachable = results.flatMap(({ url, r }) => (r.ok ? [] : [url]));

    const limits = await this.config.readLimits(action.agentName);
    const threshold = Number(
      await this.config.client.readContract({
        address: this.config.verifierSet,
        abi: verifierSetAbi,
        functionName: "threshold",
      }),
    );
    // The owner can ask for more signatures than the contract's floor, never fewer.
    const required = Math.max(threshold, limits?.requiredVerifiers ?? threshold);

    const base = {
      id: randomBytes(8).toString("hex"),
      action,
      actionHash: actionHash(action),
      requested: action.kind === "swap" ? action.amountIn : action.authorization.value,
      required,
      evaluations,
      unreachable,
      decidedAt: Math.floor(Date.now() / 1000),
    };

    const signing = evaluations.filter((e) => e.verdict === "ALLOW" || e.verdict === "REDUCE");
    const urlByVerifier = new Map(
      results.flatMap(({ url, r }) => (r.ok ? [[r.data.verifier, url] as const] : [])),
    );

    if (signing.length < required) {
      const needHuman = evaluations.filter((e) => e.verdict === "HUMAN_REQUIRED").length;
      const verdict: Verdict = signing.length + needHuman >= required && needHuman > 0 ? "HUMAN_REQUIRED" : "BLOCK";
      return { ...base, verdict };
    }

    if (action.kind === "payment") {
      const signed = await this.collect(signing.map((e) => urlByVerifier.get(e.verifier)!), { kind: "payment", action }, timeoutMs);
      if (signed.length < required) return { ...base, verdict: "BLOCK" };
      return { ...base, verdict: "ALLOW", verifierSignatures: signed };
    }

    if (!limits) return { ...base, verdict: "BLOCK" };

    // The largest amount that `required` verifiers will all sign for.
    const amounts = signing.map((e) => BigInt(e.maxAmount)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const maxAmountIn = amounts[required - 1]!;
    const verdict: Verdict = maxAmountIn < BigInt(action.amountIn) ? "REDUCE" : "ALLOW";

    const expiry = Math.floor(Date.now() / 1000) + CLEARANCE_SECONDS;
    const nonce = BigInt(`0x${randomBytes(31).toString("hex")}`);
    const hash = inputsHash(action, limits);
    const signers = signing.filter((e) => BigInt(e.maxAmount) >= maxAmountIn);
    const signed = await this.collect(
      signers.map((e) => urlByVerifier.get(e.verifier)!),
      {
        kind: "swap",
        action,
        maxAmountIn: maxAmountIn.toString(),
        expiry,
        nonce: nonce.toString(),
        inputsHash: hash,
      },
      timeoutMs,
    );
    if (signed.length < required) return { ...base, verdict: "BLOCK" };

    const clearance: SwapClearance = {
      agent: action.account,
      poolId: poolId(action.pool),
      zeroForOne: action.zeroForOne,
      maxAmountIn,
      expiry: BigInt(expiry),
      chainId: BigInt(this.config.chainId),
      nonce,
      inputsHash: hash,
    };
    const signatures = sortBySigner(signed);
    return {
      ...base,
      verdict,
      clearance: {
        agent: action.account,
        poolId: clearance.poolId,
        zeroForOne: action.zeroForOne,
        maxAmountIn: maxAmountIn.toString(),
        expiry,
        chainId: this.config.chainId,
        nonce: nonce.toString(),
        inputsHash: hash,
      },
      signatures,
      hookData: encodeHookData(clearance, signatures),
    };
  }

  private async collect(urls: string[], proposal: unknown, timeoutMs: number): Promise<SignedBy[]> {
    const results = await Promise.all(urls.map((url) => post<SignedBy>(`${url}/sign`, proposal, timeoutMs)));
    return results.flatMap((r) => (r.ok ? [r.data] : []));
  }
}
