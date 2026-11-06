import { LocalAttestor, apiApp, HumanGate, Store, x402Paywall, scanTokenFor } from "@clearance/api";
import { Agent, mockOwner, type ScenarioContext } from "@clearance/agent";
import { mockWorldApp, TEST_ACR } from "@clearance/mock-world";
import { WORLD_ACR, loadDeployment, setupAgentName, type Deployment } from "@clearance/shared";
import { Verifier, verifierApp, type ReviewConfig } from "@clearance/verifier";
import { serve, type ServerType } from "@hono/node-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createPublicClient, createTestClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACCOUNTS, RESOLVER_SET_LATER, ROOT, V4_SEPOLIA, agentRecords, deployLocal, freePort, startAnvil, testAddress, testKey } from "../scripts/local";

export const ADMIN_TOKEN = "test-admin-token";

export type Harness = {
  deployment: Deployment;
  rpcUrl: string;
  apiUrl: string;
  issuer: string;
  ctx: ScenarioContext;
  verifiers: Verifier[];
  stop: () => Promise<void>;
};

function listen(fetch: (r: Request) => Response | Promise<Response>, port: number): Promise<ServerType> {
  return new Promise((done) => {
    const server = serve({ fetch, port, hostname: "127.0.0.1" }, () => done(server));
  });
}

export async function startHarness(
  options: { review?: ReviewConfig[]; deadVerifier?: boolean; x402?: boolean; forkUrl?: string } = {},
): Promise<Harness> {
  const anvilPort = await freePort();
  const { child: anvil, rpcUrl } = await startAnvil(anvilPort, options.forkUrl);
  const deploymentFile = resolve(ROOT, "deployments", `test-${anvilPort}.json`);

  if (options.forkUrl) {
    // Anvil's default accounts carry EIP-7702 code on Sepolia, which breaks ERC-1155 mints to them.
    const test = createTestClient({ mode: "anvil", transport: http(rpcUrl) });
    for (const index of Object.values(ACCOUNTS)) await test.setCode({ address: testAddress(index), bytecode: "0x" });
  }
  deployLocal(rpcUrl, deploymentFile, options.forkUrl ? { ...V4_SEPOLIA, RESOLVER: RESOLVER_SET_LATER } : {});
  const deployment = loadDeployment(deploymentFile);
  rmSync(deploymentFile);

  if (options.forkUrl) {
    const chain = {
      id: deployment.chainId,
      name: "sepolia fork",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    };
    const test = createTestClient({ mode: "anvil", chain, transport: http(rpcUrl) });
    const ens = await setupAgentName({
      client: createPublicClient({ chain, transport: http(rpcUrl) }) as never,
      wallet: createWalletClient({ account: privateKeyToAccount(testKey(ACCOUNTS.owner)), chain, transport: http(rpcUrl) }),
      parentLabel: `clearance-${randomBytes(5).toString("hex")}`,
      agentLabel: "alice",
      records: agentRecords(deployment, "local-owner"),
      waitForCommitment: async (seconds) => {
        await test.increaseTime({ seconds });
        await test.mine({ blocks: 1 });
      },
    });
    deployment.resolver = ens.resolver;
    deployment.agentName = ens.name;
  }

  const worldPort = await freePort();
  const issuer = `http://127.0.0.1:${worldPort}`;
  const clientId = "test-client";
  const servers: ServerType[] = [];
  servers.push(await listen((await mockWorldApp({ issuer, clientId, sub: "local-owner" })).fetch, worldPort));

  const client = createPublicClient({ transport: http(rpcUrl) });
  const verifierKeys = [ACCOUNTS.verifier1, ACCOUNTS.verifier2, ACCOUNTS.verifier3];
  const verifiers: Verifier[] = [];
  const verifierUrls: string[] = [];
  for (const [i, index] of verifierKeys.entries()) {
    const port = await freePort();
    verifierUrls.push(`http://127.0.0.1:${port}`);
    if (options.deadVerifier && i === 2) continue;
    const review = options.review?.[i] ?? { provider: "none" as const };
    const verifier = new Verifier({
      signer: privateKeyToAccount(testKey(index)),
      client: client as never,
      chainId: deployment.chainId,
      hook: deployment.hook,
      quoter: deployment.quoter,
      stateView: deployment.stateView,
      resolver: deployment.resolver,
      stableTokens: [deployment.usdc],
      review,
      human: { issuer, jwksUri: `${issuer}/jwks.json`, clientId, acceptedAcr: WORLD_ACR },
    });
    verifiers.push(verifier);
    servers.push(await listen(verifierApp(verifier, { provider: review.provider }).fetch, port));
  }

  const tempDir = mkdtempSync(join(tmpdir(), "clearance-test-"));
  const store = new Store(join(tempDir, "test.db"));
  const apiPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const human = new HumanGate(
    { issuer, clientId, redirectUri: `${apiUrl}/v1/human/callback/world`, acceptedAcr: [TEST_ACR] },
    store,
  );
  const paywall = options.x402 === false
    ? undefined
    : x402Paywall(
        {
          network: `eip155:${deployment.chainId}`,
          chainId: deployment.chainId,
          usdc: deployment.usdc,
          payTo: deployment.treasury,
          priceRaw: "10000",
          facilitatorKey: testKey(ACCOUNTS.facilitator),
          rpcUrl,
        },
        "POST /v1/clear/swap",
        "One clearance check",
      );
  const chain = {
    id: deployment.chainId,
    name: "anvil",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const app = apiApp({
    client: client as never,
    deployment,
    verifierUrls,
    store,
    human,
    paywall,
    publicUrl: apiUrl,
    reportToken: "test-token",
    adminToken: ADMIN_TOKEN,
    attestor: new LocalAttestor(
      client as never,
      createWalletClient({ account: privateKeyToAccount(testKey(ACCOUNTS.attestor)), chain, transport: http(rpcUrl) }),
      deployment,
    ),
    scanToken: (address) => scanTokenFor(client as never, address),
    localOwnerWallet: createWalletClient({ account: privateKeyToAccount(testKey(ACCOUNTS.owner)), chain, transport: http(rpcUrl) }),
  });
  servers.push(await listen(app.fetch, apiPort));

  const agent = new Agent({ apiUrl, rpcUrl, deployment, agentKey: testKey(ACCOUNTS.agent), reportToken: "test-token" });

  return {
    deployment,
    rpcUrl,
    apiUrl,
    issuer,
    verifiers,
    ctx: {
      agent,
      owner: mockOwner,
      apiUrl,
      thiefKey: testKey(ACCOUNTS.thief),
      evilPayee: testAddress(ACCOUNTS.evilPayee),
    },
    stop: async () => {
      for (const server of servers) {
        server.close();
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }
      anvil.kill();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
