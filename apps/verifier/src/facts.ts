import {
  RECORD_KEYS,
  agentNode,
  parseLimits,
  poolId,
  quoterAbi,
  resolverAbi,
  scanToken,
  stateViewAbi,
  erc20Abi,
  type Limits,
  type PoolKey,
  type RawRecords,
} from "@clearance/shared";
import { getAddress, type Address, type PublicClient } from "viem";
import type { Sourced, TokenFacts } from "./rules";

const Q96 = 2n ** 96n;
function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function sourced<T>(source: string, read: () => Promise<T>): Promise<Sourced<T>> {
  try {
    return { value: await read(), source, fetchedAt: now() };
  } catch (error) {
    return { error: (error as Error).message.split("\n")[0] ?? "read failed", source };
  }
}

export function readLimits(client: PublicClient, resolver: Address, name: string): Promise<Sourced<Limits>> {
  return sourced("ens", async () => {
    const node = agentNode(name);
    const entries = await Promise.all(
      Object.entries(RECORD_KEYS).map(async ([field, key]) => {
        const value = await client.readContract({ address: resolver, abi: resolverAbi, functionName: "text", args: [node, key] });
        return [field, value] as const;
      }),
    );
    return parseLimits(Object.fromEntries(entries) as RawRecords);
  });
}

export function readToken(client: PublicClient, address: Address): Promise<Sourced<TokenFacts>> {
  return sourced("bytecode", () => scanToken(client, address));
}

export async function quoteOut(
  client: PublicClient,
  quoter: Address,
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  return result[0];
}

/** Output at the pool's current price, before fees and impact, scaled by 1e18 to keep precision. */
async function spotOutPerIn(client: PublicClient, stateView: Address, key: PoolKey, zeroForOne: boolean): Promise<{ num: bigint; den: bigint }> {
  const [sqrtPriceX96] = await client.readContract({
    address: stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId(key)],
  });
  if (sqrtPriceX96 === 0n) throw new Error("pool isn't initialized");
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const q192 = Q96 * Q96;
  return zeroForOne ? { num: priceX192, den: q192 } : { num: q192, den: priceX192 };
}

function impactBps(amountIn: bigint, amountOut: bigint, spot: { num: bigint; den: bigint }): number {
  const ideal = (amountIn * spot.num) / spot.den;
  if (ideal === 0n) throw new Error("trade is too small to price");
  if (amountOut >= ideal) return 0;
  return Number(((ideal - amountOut) * 10_000n) / ideal);
}

export type MarketFacts = {
  impactBps: Sourced<number>;
  safeAmountIn: Sourced<bigint>;
  sizeUsd: Sourced<number>;
  usdPerRawIn: Sourced<number>;
};

export async function readMarket(
  client: PublicClient,
  addresses: { quoter: Address; stateView: Address },
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  maxImpactBps: number | undefined,
  stableTokens: Address[],
): Promise<MarketFacts> {
  const spot = sourced("stateview", () => spotOutPerIn(client, addresses.stateView, key, zeroForOne));
  const spotValue = await spot;
  if ("error" in spotValue) {
    return { impactBps: spotValue, safeAmountIn: spotValue, sizeUsd: spotValue, usdPerRawIn: spotValue };
  }

  const measure = async (amount: bigint) =>
    impactBps(amount, await quoteOut(client, addresses.quoter, key, zeroForOne, amount), spotValue.value);

  const impact = await sourced("quoter", () => measure(amountIn));

  const safeAmountIn = await sourced("quoter", async () => {
    if (maxImpactBps === undefined) throw new Error("no impact limit to check against");
    const full = await measure(amountIn);
    if (full <= maxImpactBps) return amountIn;
    // Bisect for the largest amount within the limit. Twelve steps gets within 0.03% of the request.
    let low = 0n;
    let high = amountIn;
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2n;
      if (mid === 0n) break;
      let within = false;
      try {
        within = (await measure(mid)) <= maxImpactBps;
      } catch {
        within = false;
      }
      if (within) low = mid;
      else high = mid;
    }
    return low;
  });

  const tokenIn = getAddress(zeroForOne ? key.currency0 : key.currency1);
  const tokenOut = getAddress(zeroForOne ? key.currency1 : key.currency0);

  const usdPerRawIn = await sourced("pool", async () => {
    const stableDecimals = async (token: Address) =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    if (stableTokens.includes(tokenIn)) return 10 ** -(await stableDecimals(tokenIn));
    if (stableTokens.includes(tokenOut)) {
      const scaled = Number(spotValue.value.num * 10n ** 18n / spotValue.value.den) / 1e18;
      return scaled * 10 ** -(await stableDecimals(tokenOut));
    }
    throw new Error("neither side of this pool is a stablecoin, so the trade can't be priced");
  });

  const sizeUsd: Sourced<number> =
    "error" in usdPerRawIn
      ? usdPerRawIn
      : { value: Number(amountIn) * usdPerRawIn.value, source: usdPerRawIn.source, fetchedAt: usdPerRawIn.fetchedAt };

  return { impactBps: impact, safeAmountIn, sizeUsd, usdPerRawIn };
}
