import { erc20Abi } from "@clearance/shared";
import { createWalletClient, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, testKey } from "../scripts/local";
import { startHarness, type Harness } from "./harness";

const poolKeyTuple = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const abi = parseAbi([
  `function initialize(${poolKeyTuple} key, uint160 sqrtPriceX96) returns (int24)`,
  `function modifyLiquidity(${poolKeyTuple} key, (int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt) params, bytes hookData) payable returns (int256)`,
]);

/** A pool using the real hook and allowed tokens, priced so USDC buys almost nothing. */
describe("a pool the owner never approved", () => {
  it("can't be opened on the hook by a stranger", async () => {
    const thief = createWalletClient({
      account: privateKeyToAccount(testKey(ACCOUNTS.thief)),
      chain: { id: h.deployment.chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [h.rpcUrl] } } },
      transport: http(h.rpcUrl),
    });
    await expect(
      h.ctx.agent.client.simulateContract({
        account: thief.account,
        address: h.deployment.poolManager,
        abi,
        functionName: "initialize",
        args: [attackerKey(100), 2n ** 96n],
      }),
    ).rejects.toThrow();
  });

  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ x402: false });
  }, 180_000);
  afterAll(async () => {
    await h?.stop();
  });

  function attackerKey(fee: number) {
    const { usdc, weth, hook } = h.deployment;
    const [currency0, currency1] = BigInt(usdc) < BigInt(weth) ? [usdc, weth] : [weth, usdc];
    return { currency0, currency1, fee, tickSpacing: 10, hooks: hook };
  }

  it("an owner-opened pool outside the ENS list gets no clearance, however good its own price looks", async () => {
    const wallet = createWalletClient({
      account: privateKeyToAccount(testKey(ACCOUNTS.owner)),
      chain: { id: h.deployment.chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [h.rpcUrl] } } },
      transport: http(h.rpcUrl),
    });
    const key = attackerKey(500);
    const zeroForOne = key.currency0 === h.deployment.usdc;
    const client = h.ctx.agent.client;
    const wait = async (hash: `0x${string}`) => client.waitForTransactionReceipt({ hash });

    // 1 raw tWETH unit costs about 1 USDC, at a price thousands of billions of times worse than the real pool.
    const price = zeroForOne ? 2n ** 96n / 1000n : 2n ** 96n * 1000n;
    await wait(await wallet.writeContract({ address: h.deployment.poolManager, abi, functionName: "initialize", args: [key, price] }));
    for (const token of [h.deployment.usdc, h.deployment.weth]) {
      await wait(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [h.deployment.liquidityHelper, 2n ** 255n] }));
    }
    const tick = zeroForOne ? -138160 : 138160;
    await wait(
      await wallet.writeContract({
        address: h.deployment.liquidityHelper,
        abi,
        functionName: "modifyLiquidity",
        args: [key, { tickLower: tick - 2000, tickUpper: tick + 2000, liquidityDelta: 10n ** 13n, salt: `0x${"00".repeat(32)}` }, "0x"],
      }),
    );

    const amount = parseUnits("900", 6);
    const decision = await h.ctx.agent.clearSwap(h.ctx.agent.swapAction(key, zeroForOne, amount, "A pool with a great price"));
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.hookData).toBeUndefined();
    expect(decision.evaluations[0]?.reasons.map((r) => r.code)).toContain("pool_not_allowed");
  });
});
