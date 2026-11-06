import { readFileSync } from "node:fs";
import type { Address } from "viem";
import type { PoolKey } from "./actions";

export type Deployment = {
  chainId: number;
  agentName: string;
  owner: Address;
  agentKey: Address;
  treasury: Address;
  poolManager: Address;
  quoter: Address;
  stateView: Address;
  usdc: Address;
  verifierSet: Address;
  router: Address;
  hook: Address;
  account: Address;
  resolver: Address;
  weth: Address;
  moon: Address;
  rug: Address;
  wethPool: PoolKey;
  moonPool: PoolKey;
  rugPool: PoolKey;
  outsideRugPool: PoolKey;
};

export function loadDeployment(path: string): Deployment {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  // forge's serializeString stores nested objects as JSON strings on some versions.
  for (const key of ["wethPool", "moonPool", "rugPool", "outsideRugPool"]) {
    if (typeof raw[key] === "string") raw[key] = JSON.parse(raw[key] as string);
  }
  return raw as unknown as Deployment;
}
