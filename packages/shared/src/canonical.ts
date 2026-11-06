import { keccak256, stringToHex, type Hex } from "viem";
import type { Action, SwapAction } from "./actions";
import type { Limits } from "./limits";

/** Stable JSON: sorted keys, bigint as a decimal string, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

/** The agent's free-text reason is left out, so changing it can't change what gets approved. */
export function actionHash(action: Action): Hex {
  const { reason: _reason, ...rest } = action;
  return hashCanonical(rest);
}

/** What the clearance commits to: the exact action and the limits it was judged against. */
export function inputsHash(action: SwapAction, limits: Limits): Hex {
  return hashCanonical({ action: actionHash(action), limits });
}
