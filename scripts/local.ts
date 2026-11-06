import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { Deployment, RawRecords } from "@clearance/shared";
import { bytesToHex, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

export const ROOT = resolve(import.meta.dirname, "..");

const MNEMONIC = "test test test test test test test test test test test junk";

/** Anvil's public test accounts. None of these keys may ever hold real funds. */
export function testKey(index: number): Hex {
  const key = mnemonicToAccount(MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!key) throw new Error("Couldn't derive test key");
  return bytesToHex(key);
}

export function testAddress(index: number) {
  return mnemonicToAccount(MNEMONIC, { addressIndex: index }).address;
}

export const ACCOUNTS = { owner: 0, agent: 1, thief: 2, verifier1: 3, verifier2: 4, verifier3: 5, facilitator: 6, treasury: 7, evilPayee: 8, attestor: 9 };

export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

async function waitForRpc(url: string, child: ChildProcess, errors: () => string) {
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${errors()}`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil didn't start");
}

/** Starts a throwaway anvil on its own port. Stop it with the returned child's PID, never by name. */
export async function startAnvil(port: number, forkUrl?: string): Promise<{ child: ChildProcess; rpcUrl: string }> {
  const fork = forkUrl ? ["--fork-url", forkUrl] : [];
  const child = spawn("anvil", ["--port", String(port), "--silent", "--host", "127.0.0.1", ...fork], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d;
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitForRpc(rpcUrl, child, () => stderr.slice(-500));
  return { child, rpcUrl };
}

/** v4 as deployed on Sepolia. Passing these makes a deploy use the real contracts rather than fresh ones. */
export const V4_SEPOLIA = {
  POOL_MANAGER: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  QUOTER: "0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244",
  STATE_VIEW: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
};

/** A resolver address is needed to deploy, and the real one needs the deployed account. This fills the gap. */
export const RESOLVER_SET_LATER = "0x0000000000000000000000000000000000000001";

export function agentRecords(d: Pick<Deployment, "account" | "usdc" | "weth" | "moon" | "treasury">, ownerSub: string): RawRecords {
  return {
    account: d.account,
    maxSizeUsd: "1000",
    humanCapUsd: "25000",
    maxImpactBps: "300",
    requiredVerifiers: "2",
    allowedTokens: [d.usdc, d.weth, d.moon].join(","),
    maxPaymentUsd: "1",
    allowedPayees: d.treasury,
    ownerSub,
  };
}

/** Deploys to the given chain. Only ever call this with a throwaway local RPC. */
export function deployLocal(rpcUrl: string, deploymentFile: string, extraEnv: Record<string, string> = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) throw new Error(`Refusing a local deploy to ${rpcUrl}`);
  execFileSync("forge", ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--silent"], {
    cwd: resolve(ROOT, "contracts"),
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      OWNER_KEY: testKey(ACCOUNTS.owner),
      AGENT_KEY_ADDRESS: testAddress(ACCOUNTS.agent),
      VERIFIER_ADDRESSES: [ACCOUNTS.verifier1, ACCOUNTS.verifier2, ACCOUNTS.verifier3].map(testAddress).join(","),
      TREASURY_ADDRESS: testAddress(ACCOUNTS.treasury),
      ATTEST_FORWARDER: testAddress(ACCOUNTS.attestor),
      DEPLOYMENT_FILE: deploymentFile,
      ...extraEnv,
    },
  });
}

