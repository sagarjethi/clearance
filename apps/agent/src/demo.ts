import { resolve } from "node:path";
import { loadDeployment } from "@clearance/shared";
import { ACCOUNTS, ROOT, testAddress, testKey } from "../../../scripts/local";
import { Agent } from "./agent";
import { mockOwner } from "./mockOwner";
import { runScenario, scenarios } from "./scenarios";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:18787";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:18545";
const deployment = loadDeployment(process.env.DEPLOYMENT_FILE ?? resolve(ROOT, "deployments/local.json"));
const agent = new Agent({ apiUrl, rpcUrl, deployment, agentKey: testKey(ACCOUNTS.agent), reportToken: process.env.REPORT_TOKEN ?? "local-report-token" });

let failed = 0;
for (const scenario of scenarios) {
  const result = await runScenario(scenario, {
    agent,
    owner: mockOwner,
    apiUrl,
    thiefKey: testKey(ACCOUNTS.thief),
    evilPayee: testAddress(ACCOUNTS.evilPayee),
  });
  console.log(`\n${result.pass ? "PASS" : "FAIL"}  ${result.title}`);
  for (const check of result.checks) console.log(`  ${check.pass ? "ok " : "NO "} ${check.label}\n       ${check.detail}`);
  if (result.error) console.log(`  error: ${result.error}`);
  if (!result.pass) failed++;
}
console.log(`\n${scenarios.length - failed} of ${scenarios.length} scenarios passed`);
process.exit(failed ? 1 : 0);
