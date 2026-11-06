import { runScenario, scenarios } from "@clearance/agent";
import { erc20Abi } from "@clearance/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness";

describe("every scenario, end to end on a throwaway chain", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  for (const scenario of scenarios) {
    it(scenario.title, async () => {
      const result = await runScenario(scenario, h.ctx);
      expect(result.error).toBeUndefined();
      for (const check of result.checks) {
        expect({ label: check.label, detail: check.detail, pass: check.pass }).toMatchObject({ pass: true });
      }
      expect(result.checks.length).toBeGreaterThan(0);
    }, 120_000);
  }

  it("settled x402 fees reach the treasury in USDC", async () => {
    const treasury = await h.ctx.agent.client.readContract({
      address: h.deployment.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [h.deployment.treasury],
    });
    expect(treasury).toBeGreaterThan(0n);
  });
});
