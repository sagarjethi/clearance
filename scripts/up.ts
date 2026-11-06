import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { ACCOUNTS, ROOT, deployLocal, startAnvil, testAddress, testKey } from "./local";

const PORTS = { anvil: 18545, world: 18791, verifiers: [18701, 18702, 18703], api: 18787, runner: 18788, web: 5183, site: 5184 };
const children: ChildProcess[] = [];

function run(name: string, command: string, args: string[], env: Record<string, string>, cwd = ROOT) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

function stopAll() {
  // Only the processes this script started, by handle. Other forks on this machine are left alone.
  for (const child of children) child.kill();
}
process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});

const { child: anvil, rpcUrl } = await startAnvil(PORTS.anvil);
children.push(anvil);

const deploymentFile = resolve(ROOT, "deployments/local.json");
console.log("deploying contracts to the local chain");
deployLocal(rpcUrl, deploymentFile);

const issuer = `http://127.0.0.1:${PORTS.world}`;
const clientId = "local-client";
const world = { WORLD_ISSUER: issuer, WORLD_JWKS_URI: `${issuer}/jwks.json`, WORLD_CLIENT_ID: clientId };
const common = { DEPLOYMENT_FILE: deploymentFile, RPC_URL: rpcUrl, ...world };
const tsx = resolve(ROOT, "node_modules/.bin/tsx");

run("world", tsx, ["apps/mock-world/src/main.ts"], { PORT: String(PORTS.world), MOCK_ISSUER: issuer, WORLD_CLIENT_ID: clientId });

const verifierAccounts = [ACCOUNTS.verifier1, ACCOUNTS.verifier2, ACCOUNTS.verifier3];
PORTS.verifiers.forEach((port, i) => {
  const n = i + 1;
  run(`verifier${n}`, tsx, ["apps/verifier/src/main.ts"], {
    ...common,
    PORT: String(port),
    VERIFIER_KEY: testKey(verifierAccounts[i]!),
    MODEL_PROVIDER: process.env[`VERIFIER${n}_PROVIDER`] ?? "none",
    MODEL_NAME: process.env[`VERIFIER${n}_MODEL`] ?? "",
    MODEL_API_KEY: process.env[`VERIFIER${n}_API_KEY`] ?? "",
  });
});

const apiUrl = `http://127.0.0.1:${PORTS.api}`;
const reportToken = "local-report-token";
const adminToken = "local-admin-token";
run("api", tsx, ["apps/api/src/main.ts"], {
  ...common,
  PORT: String(PORTS.api),
  PUBLIC_URL: apiUrl,
  DASHBOARD_URL: `http://localhost:${PORTS.web}/`,
  // A new chain gets a new history file, so nothing old is ever overwritten.
  CLEARANCE_DB: resolve(ROOT, `data/run-${Date.now()}.db`),
  VERIFIER_URLS: PORTS.verifiers.map((p) => `http://127.0.0.1:${p}`).join(","),
  REPORT_TOKEN: reportToken,
  LOCAL_OWNER_KEY: testKey(ACCOUNTS.owner),
  X402_PRICE_RAW: "10000",
  X402_FACILITATOR_KEY: testKey(ACCOUNTS.facilitator),
  LOCAL_ATTESTOR_KEY: testKey(ACCOUNTS.attestor),
  ADMIN_TOKEN: adminToken,
});

async function waitFor(url: string) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} didn't start`);
}
await waitFor(`${apiUrl}/health`);

run("runner", tsx, ["apps/agent/src/runner.ts"], {
  ...common,
  PORT: String(PORTS.runner),
  API_URL: apiUrl,
  AGENT_KEY: testKey(ACCOUNTS.agent),
  THIEF_KEY: testKey(ACCOUNTS.thief),
  EVIL_PAYEE: testAddress(ACCOUNTS.evilPayee),
  REPORT_TOKEN: reportToken,
});

run("web", resolve(ROOT, "apps/web/node_modules/.bin/vite"), ["--port", String(PORTS.web), "--strictPort"], { ADMIN_TOKEN: adminToken, API_URL: apiUrl, RUNNER_URL: `http://127.0.0.1:${PORTS.runner}` }, resolve(ROOT, "apps/web"));
run("site", resolve(ROOT, "apps/site/node_modules/.bin/vite"), ["--port", String(PORTS.site), "--strictPort"], { VITE_API_URL: apiUrl, VITE_DASHBOARD_URL: `http://localhost:${PORTS.web}/` }, resolve(ROOT, "apps/site"));

console.log(`\nClearance is starting. Website: http://localhost:${PORTS.site}/\nDashboard: http://localhost:${PORTS.web}/\nRun every scenario from the dashboard, or with: pnpm demo\n`);
