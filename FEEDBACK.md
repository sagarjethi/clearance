# Uniswap feedback

Friction from building a v4 hook and router for this project.
Team: review and add your own experience before submitting.

## What worked well

- `IMsgSender` on the routers gives a hook the real caller. `msgSender()` returned the original caller on all three Sepolia Universal Router versions we tried.
- `hookData` arrives unchanged, which makes a signed permit in `hookData` a clean pattern.
- The Sepolia PoolManager, Quoter and StateView worked with a fresh hook on a fork with no changes.

## What slowed us down

- **Compiler settings.** `PoolManager` fails with "stack too deep" unless you match v4-core's `via_ir` and `optimizer_runs = 44444444`. The error doesn't point there.
- **The `transient` keyword.** v4-core pins solc 0.8.26, which doesn't have it, so a new router has to write `tstore` by hand.
- **Moving imports.** `BaseHook` isn't in current `v4-periphery`, and `SwapParams` moved to `PoolOperation.sol`, while many guides still show the old paths.
- **Universal Router versions.** Routers 2.1.1 and 2.1.2 add `minHopPriceX36` to the single-swap structs, and the template's periphery lacks it. A wrong encoding reverts with empty data.
- **Wrapped reverts.** A hook's error arrives inside `WrappedError`, so an agent needs its own decoder to report why a swap failed.
- **Anyone can open a pool on your hook.** This was our worst bug. Without a `beforeInitialize` gate, a stranger's pool on our hook set its own price, and our checks trusted it. The hook docs should warn about this.
- **Quoting gated pools.** A hook that needs a signature also reverts for the Quoter, so we had to allowlist it. A note about this in the hook docs would help.
- **Exact-output swaps.** `beforeSwap` can't bound the input of an exact-output swap, so we refuse them. A short note on this limit would save time for anyone building limits in a hook.
- **`EasyPosm.mint`** fails in scripts, so we added liquidity another way.
