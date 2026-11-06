import {
  RECORD_KEYS,
  agentNode,
  erc20Abi,
  parseLimits,
  paymentActionSchema,
  resolverAbi,
  swapActionSchema,
  verifierSetAbi,
  type Action,
  type Deployment,
  type HumanProof,
  type Limits,
  type RawRecords,
} from "@clearance/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Hex, PublicClient, WalletClient } from "viem";
import { Coordinator, type Decision } from "./coordinator";
import type { HumanGate } from "./human";
import type { FeedEvent, Store } from "./store";

export type ApiConfig = {
  client: PublicClient;
  deployment: Deployment;
  verifierUrls: string[];
  store: Store;
  human?: HumanGate;
  paywall?: MiddlewareHandler;
  /** Lets the dashboard edit limits. Set only in local mode, where the owner key is a public test key. */
  localOwnerWallet?: WalletClient;
  /** Lets the agent report onchain outcomes to the feed. */
  reportToken?: string;
  publicUrl: string;
};

const swapBody = z.object({ action: swapActionSchema, checkpointId: z.string().max(64).optional() });
const paymentBody = z.object({ action: paymentActionSchema });
const outcomeBody = z.object({
  scenario: z.string().max(80).optional(),
  label: z.string().max(200),
  result: z.enum(["executed", "reverted", "refused"]),
  detail: z.string().max(500),
  txHash: z.string().max(70).optional(),
  decisionId: z.string().max(40).optional(),
});
const limitsBody = z.object({
  maxSizeUsd: z.number().min(0).optional(),
  humanCapUsd: z.number().min(0).optional(),
  maxImpactBps: z.number().int().min(0).max(10_000).optional(),
});

export function apiApp(config: ApiConfig) {
  const { client, deployment, store, human } = config;
  const app = new Hono();
  const subscribers = new Set<(event: FeedEvent) => void>();

  const publish = (type: FeedEvent["type"], data: unknown) => {
    const event = store.addEvent(type, data);
    for (const notify of subscribers) notify(event);
    return event;
  };

  async function readRecords(name: string): Promise<RawRecords> {
    const node = agentNode(name);
    const entries = await Promise.all(
      Object.entries(RECORD_KEYS).map(async ([field, key]) => [
        field,
        await client.readContract({ address: deployment.resolver, abi: resolverAbi, functionName: "text", args: [node, key] }),
      ]),
    );
    return Object.fromEntries(entries);
  }

  async function readLimits(name: string): Promise<Limits | undefined> {
    try {
      return parseLimits(await readRecords(name));
    } catch {
      return undefined;
    }
  }

  const coordinator = new Coordinator({
    verifierUrls: config.verifierUrls,
    client,
    chainId: deployment.chainId,
    verifierSet: deployment.verifierSet,
    readLimits,
  });

  function checkAgent(action: Action): string | undefined {
    if (action.agentName !== deployment.agentName || action.account !== deployment.account) {
      return "Unknown agent for this deployment";
    }
    return undefined;
  }

  async function record(decision: Decision, checkpoint?: { id: string; url: string }) {
    publish("decision", { ...decision, checkpoint });
  }

  app.get("/health", (c) => c.json({ ok: true, chainId: deployment.chainId }));

  // Paying through x402 happens before this handler runs. Invalid input gets a 400 and no settlement.
  if (config.paywall) app.use("/v1/clear/swap", config.paywall);

  app.post("/v1/clear/swap", async (c) => {
    const parsed = swapBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const { action, checkpointId } = parsed.data;
    const unknown = checkAgent(action);
    if (unknown) return c.json({ error: unknown }, 404);

    let proof: HumanProof | undefined;
    if (checkpointId) {
      const checkpoint = human?.read(checkpointId);
      if (checkpoint?.status === "approved" && checkpoint.idToken) {
        proof = { idToken: checkpoint.idToken, salt: checkpoint.salt as Hex };
      }
    }

    const decision = await coordinator.decide(action, proof);

    if (decision.verdict === "HUMAN_REQUIRED" && human) {
      const fresh = human.create(action);
      const checkpoint = { id: fresh.id, url: `${config.publicUrl}/v1/human/${fresh.id}/start` };
      await record(decision, checkpoint);
      publish("checkpoint", { id: fresh.id, status: "pending", decisionId: decision.id, action });
      return c.json({ ...decision, checkpoint });
    }
    await record(decision);
    return c.json(decision);
  });

  app.post("/v1/clear/payment", async (c) => {
    const parsed = paymentBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const unknown = checkAgent(parsed.data.action);
    if (unknown) return c.json({ error: unknown }, 404);
    const decision = await coordinator.decide(parsed.data.action);
    await record(decision);
    return c.json(decision);
  });

  app.get("/v1/human/:id", (c) => {
    const checkpoint = human?.read(c.req.param("id"));
    if (!checkpoint) return c.json({ error: "not found" }, 404);
    return c.json({ id: checkpoint.id, status: checkpoint.status, detail: checkpoint.detail, action: checkpoint.action });
  });

  app.get("/v1/human/:id/start", async (c) => {
    const checkpoint = human?.read(c.req.param("id"));
    if (!human || !checkpoint) return c.json({ error: "not found" }, 404);
    if (checkpoint.status !== "pending") return c.json({ error: `checkpoint is ${checkpoint.status}` }, 409);
    return c.redirect(await human.authorizationUrl(checkpoint));
  });

  app.get("/v1/human/callback/world", async (c) => {
    if (!human) return c.json({ error: "human gate is not configured" }, 404);
    const limits = await readLimits(deployment.agentName);
    const checkpoint = await human.callback(
      {
        state: c.req.query("state"),
        code: c.req.query("code"),
        error: c.req.query("error"),
        iss: c.req.query("iss"),
      },
      limits?.ownerSub ?? "",
    );
    if (!checkpoint) return c.json({ error: "unknown checkpoint" }, 400);
    publish("checkpoint", { id: checkpoint.id, status: checkpoint.status, detail: checkpoint.detail, action: checkpoint.action });
    if (human.returnUrl) return c.redirect(`${human.returnUrl}?checkpoint=${checkpoint.id}&status=${checkpoint.status}`);
    return c.json({ id: checkpoint.id, status: checkpoint.status, detail: checkpoint.detail });
  });

  app.get("/v1/agent", async (c) => {
    const limits = await readLimits(deployment.agentName);
    const balances = await Promise.all(
      (
        [
          ["USDC", deployment.usdc, 6],
          ["tWETH", deployment.weth, 18],
          ["tMOON", deployment.moon, 18],
          ["RUG", deployment.rug, 18],
        ] as const
      ).map(async ([symbol, token, decimals]) => ({
        symbol,
        decimals,
        raw: (
          await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [deployment.account] })
        ).toString(),
      })),
    );
    const [threshold, verifierCount] = await Promise.all([
      client.readContract({ address: deployment.verifierSet, abi: verifierSetAbi, functionName: "threshold" }),
      client.readContract({ address: deployment.verifierSet, abi: verifierSetAbi, functionName: "verifierCount" }),
    ]);
    return c.json({
      name: deployment.agentName,
      account: deployment.account,
      chainId: deployment.chainId,
      hook: deployment.hook,
      tokens: {
        [deployment.usdc]: { symbol: "USDC", decimals: 6 },
        [deployment.weth]: { symbol: "tWETH", decimals: 18 },
        [deployment.moon]: { symbol: "tMOON", decimals: 18 },
        [deployment.rug]: { symbol: "RUG", decimals: 18 },
      },
      limits: limits ?? null,
      balances,
      threshold: Number(threshold),
      verifierCount: Number(verifierCount),
      canEditLimits: Boolean(config.localOwnerWallet),
    });
  });

  app.get("/v1/verifiers", async (c) => {
    const statuses = await Promise.all(
      config.verifierUrls.map(async (url) => {
        try {
          const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
          const body = (await response.json()) as { verifier: string; provider: string };
          return { online: true, address: body.verifier, provider: body.provider };
        } catch {
          return { online: false };
        }
      }),
    );
    return c.json(statuses);
  });

  app.get("/v1/events", (c) => c.json(store.recentEvents()));

  app.get("/v1/feed", (c) =>
    streamSSE(c, async (stream) => {
      const queue: FeedEvent[] = [];
      let wake: (() => void) | undefined;
      const onEvent = (event: FeedEvent) => {
        queue.push(event);
        wake?.();
      };
      subscribers.add(onEvent);
      stream.onAbort(() => {
        subscribers.delete(onEvent);
        wake?.();
      });
      while (!stream.aborted) {
        const event = queue.shift();
        if (event) {
          await stream.writeSSE({ id: String(event.id), event: "event", data: JSON.stringify(event) });
          continue;
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ]);
        if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
      subscribers.delete(onEvent);
    }),
  );

  app.post("/v1/outcomes", async (c) => {
    if (!config.reportToken || c.req.header("authorization") !== `Bearer ${config.reportToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parsed = outcomeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    publish("outcome", parsed.data);
    return c.json({ ok: true });
  });

  app.post("/v1/limits", async (c) => {
    const wallet = config.localOwnerWallet;
    if (!wallet?.account) return c.json({ error: "Limits are edited from the owner's wallet in this mode" }, 403);
    const parsed = limitsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const node = agentNode(deployment.agentName);
    for (const [field, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      const hash = await wallet.writeContract({
        address: deployment.resolver,
        abi: resolverAbi,
        functionName: "setText",
        args: [node, RECORD_KEYS[field as keyof typeof RECORD_KEYS], String(value)],
        account: wallet.account,
        chain: wallet.chain,
      });
      await client.waitForTransactionReceipt({ hash });
    }
    return c.json({ limits: await readLimits(deployment.agentName) });
  });

  return app;
}
