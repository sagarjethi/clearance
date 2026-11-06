import {
  ENSV2_SEPOLIA,
  grantRecordWriter,
  loadDeployment,
  setupAgentName,
} from "@clearance/shared";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { RESOLVER_SET_LATER, ROOT, V4_SEPOLIA, agentRecords } from "./local";

/**
 * Deploys Clearance to real Sepolia and creates the agent's ENSv2 name. This spends the owner's testnet
 * ETH, and pauses about a minute for the ENS commit. See .env.example for what it needs.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. See .env.example.`);
  return value;
}

const rpcUrl = required("SEPOLIA_RPC_URL");
const ownerKey = required("OWNER_KEY") as Hex;
const deploymentFile = resolve(ROOT, "deployments/sepolia.json");

const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const chainId = await client.getChainId();
if (chainId !== sepolia.id) throw new Error(`This RPC is chain ${chainId}, not Sepolia. Nothing was deployed.`);

console.log("Deploying contracts to Sepolia");
execFileSync("forge", ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", rpcUrl, "--broadcast", "--slow"], {
  cwd: resolve(ROOT, "contracts"),
  stdio: "inherit",
  env: {
    ...process.env,
    ...V4_SEPOLIA,
    RESOLVER: RESOLVER_SET_LATER,
    DEPLOYMENT_FILE: "../deployments/sepolia.json",
    OWNER_KEY: ownerKey,
    AGENT_KEY_ADDRESS: required("AGENT_KEY_ADDRESS"),
    VERIFIER_ADDRESSES: required("VERIFIER_ADDRESSES"),
    TREASURY_ADDRESS: required("TREASURY_ADDRESS"),
    ATTEST_FORWARDER: required("ATTEST_FORWARDER"),
  },
});

const deployment = loadDeployment(deploymentFile);
const wallet = createWalletClient({ account: privateKeyToAccount(ownerKey), chain: sepolia, transport: http(rpcUrl) });

const ens = await setupAgentName({
  client: client as never,
  wallet,
  parentLabel: required("ENS_PARENT_LABEL"),
  agentLabel: process.env.ENS_AGENT_LABEL ?? "alice",
  records: agentRecords(deployment, required("OWNER_SUB")),
  log: console.log,
  waitForCommitment: (seconds) => {
    console.log(`Waiting ${seconds} seconds for the ENS commitment`);
    return new Promise((done) => setTimeout(done, seconds * 1000));
  },
});

const operator = process.env.LIMIT_OPERATOR as Address | undefined;
if (operator) await grantRecordWriter(client as never, wallet, ens.resolver, ens.name, "clearance.maxImpactBps", operator);

const raw = JSON.parse(readFileSync(deploymentFile, "utf8"));
writeFileSync(deploymentFile, JSON.stringify({ ...raw, resolver: ens.resolver, agentName: ens.name, ensRegistry: ens.registry }, null, 2));

console.log(`\nDone. ${ens.name} is on ENSv2 Sepolia, and addresses are in deployments/sepolia.json.`);
console.log(`Universal Resolver: ${ENSV2_SEPOLIA.universalResolver}`);
