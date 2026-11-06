import { actionSchema, humanProofSchema, swapActionSchema, paymentActionSchema } from "@clearance/shared";
import { Hono } from "hono";
import { z } from "zod";
import { SignRefused, type Verifier } from "./verifier";

const evaluateBody = z.object({ action: actionSchema, human: humanProofSchema.optional() });
const signBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("swap"),
    action: swapActionSchema,
    maxAmountIn: z.string().regex(/^\d{1,78}$/),
    minAmountOut: z.string().regex(/^\d{1,78}$/),
    expiry: z.number().int(),
    nonce: z.string().regex(/^\d{1,78}$/),
    inputsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as `0x${string}`),
  }),
  z.object({ kind: z.literal("payment"), action: paymentActionSchema }),
]);

export function verifierApp(verifier: Verifier, info: { provider: string }) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, verifier: verifier.address, provider: info.provider }));

  app.post("/evaluate", async (c) => {
    const parsed = evaluateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    return c.json(await verifier.evaluate(parsed.data.action, parsed.data.human));
  });

  app.post("/sign", async (c) => {
    const parsed = signBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    try {
      return c.json(await verifier.sign(parsed.data));
    } catch (error) {
      if (error instanceof SignRefused) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  return app;
}
