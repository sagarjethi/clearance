import { runScenario, scenarios } from "@clearance/agent";
import { erc20Abi } from "@clearance/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness";

const FORK_URL = process.env.SEPOLIA_FORK_URL;

/**
 * Every scenario on a throwaway Sepolia fork, using the real v4 PoolManager, Quoter and StateView, Circle
 * USDC with its ERC-1271 path, and a real ENSv2 name for limits. Needs network access: SEPOLIA_FORK_URL=<url> pnpm test:ts
 */
describe.skipIf(!FORK_URL)("every scenario against real Sepolia v4, ENSv2 and Circle USDC", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ forkUrl: FORK_URL });
  }, 400_000);
  afterAll(async () => {
    await h?.stop();
  });

  it("uses the real contracts", () => {
    expect(h.deployment.chainId).toBe(11155111);
    expect(h.deployment.poolManager.toLowerCase()).toBe("0xe03a1074c86cfedd5c142c4f04f1a1536e203543");
    expect(h.deployment.usdc.toLowerCase()).toBe("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238");
    expect(h.deployment.agentName).toMatch(/^alice\.clearance-[0-9a-f]+\.eth$/);
  });

  for (const scenario of scenarios) {
    it(scenario.title, async () => {
      const result = await runScenario(scenario, h.ctx);
      expect(result.error).toBeUndefined();
      for (const check of result.checks) {
        expect({ label: check.label, detail: check.detail, pass: check.pass }).toMatchObject({ pass: true });
      }
    }, 180_000);
  }

  it("real USDC settled the x402 fees from the smart account", async () => {
    const treasury = await h.ctx.agent.client.readContract({
      address: h.deployment.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [h.deployment.treasury],
    });
    expect(treasury).toBeGreaterThan(0n);
  });
});
