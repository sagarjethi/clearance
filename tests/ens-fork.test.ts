import {
  ENSV2_SEPOLIA,
  RECORD_KEYS,
  dnsEncodeName,
  grantRecordWriter,
  permissionedResolverAbi,
  readAgentRecords,
  setupAgentName,
  type RawRecords,
} from "@clearance/shared";
import { readLimits } from "@clearance/verifier";
import { randomBytes } from "node:crypto";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, startAnvil } from "../scripts/local";

const FORK_URL = process.env.SEPOLIA_FORK_URL;

/** Needs network access, so it runs only when pointed at an RPC: SEPOLIA_FORK_URL=<url> pnpm test:ts */
describe.skipIf(!FORK_URL)("real ENSv2 contracts, on a throwaway Sepolia fork", () => {
  const ownerAccount = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  const operatorAccount = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  const parentLabel = `clearance-${randomBytes(5).toString("hex")}`;
  const account = "0x00000000000000000000000000000000000000a1";
  const token = "0x00000000000000000000000000000000000000a2";
  const records: RawRecords = {
    account,
    allowedPools: "",
    dailyPaymentUsd: "5",
    maxSizeUsd: "1000",
    humanCapUsd: "25000",
    maxImpactBps: "300",
    requiredVerifiers: "2",
    allowedTokens: token,
    maxPaymentUsd: "1",
    allowedPayees: "",
    ownerSub: "owner",
  };

  let stop: () => void;
  let rpcUrl: string;
  let client: any;
  let wallet: any;
  let result: Awaited<ReturnType<typeof setupAgentName>>;

  beforeAll(async () => {
    const port = await freePort();
    const anvil = await startAnvil(port, FORK_URL);
    stop = () => anvil.child.kill();
    rpcUrl = anvil.rpcUrl;
    const chain = {
      id: 11155111,
      name: "sepolia fork",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    };
    client = createPublicClient({ chain, transport: http(rpcUrl) });
    wallet = createWalletClient({ account: ownerAccount, chain, transport: http(rpcUrl) });
    const test = createTestClient({ mode: "anvil", chain, transport: http(rpcUrl) });
    await test.setBalance({ address: ownerAccount.address, value: parseEther("10") });
    await test.setBalance({ address: operatorAccount.address, value: parseEther("10") });

    result = await setupAgentName({
      client,
      wallet,
      parentLabel,
      agentLabel: "alice",
      records,
      log: (m) => console.log(m),
      waitForCommitment: async (seconds) => {
        await test.increaseTime({ seconds });
        await test.mine({ blocks: 1 });
      },
    });
  }, 300_000);

  afterAll(() => stop?.());

  it("verifiers read the agent's limits from the real resolver", async () => {
    const limits = await readLimits(client, result.resolver, result.name);
    if ("error" in limits) throw new Error(limits.error);
    expect(limits.value.maxSizeUsd).toBe(1000);
    expect(limits.value.account.toLowerCase()).toBe(account);
    expect(limits.value.allowedTokens.map((t) => t.toLowerCase())).toEqual([token]);
  });

  it("any ENS client can resolve the limits through the Universal Resolver", async () => {
    const value = await client.getEnsText({
      name: result.name,
      key: RECORD_KEYS.maxSizeUsd,
      universalResolverAddress: ENSV2_SEPOLIA.universalResolver,
    });
    expect(value).toBe("1000");
  });

  it("a scoped writer can change its one record, and no other", async () => {
    await grantRecordWriter(client, wallet, result.resolver, result.name, RECORD_KEYS.maxImpactBps, operatorAccount.address);
    const operator = createWalletClient({ account: operatorAccount, chain: wallet.chain, transport: http(rpcUrl) });
    const dnsName = dnsEncodeName(result.name);

    const hash = await operator.writeContract({
      chain: wallet.chain,
      address: result.resolver,
      abi: permissionedResolverAbi,
      functionName: "setText",
      args: [dnsName, RECORD_KEYS.maxImpactBps, "150"],
    });
    await client.waitForTransactionReceipt({ hash });
    expect((await readAgentRecords(client, result.resolver, result.name)).maxImpactBps).toBe("150");

    await expect(
      client.simulateContract({
        account: operatorAccount,
        address: result.resolver,
        abi: permissionedResolverAbi,
        functionName: "setText",
        args: [dnsName, RECORD_KEYS.maxSizeUsd, "99999999"],
      }),
    ).rejects.toThrow(/EACUnauthorizedAccountRoles/);
  });

  it("a stranger can't change anything", async () => {
    await expect(
      client.simulateContract({
        account: privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`),
        address: result.resolver,
        abi: permissionedResolverAbi,
        functionName: "setText",
        args: [dnsEncodeName(result.name), RECORD_KEYS.maxSizeUsd, "1"],
      }),
    ).rejects.toThrow(/EACUnauthorizedAccountRoles/);
  });

  it("registering the same parent again is refused with a clear message", async () => {
    await expect(
      setupAgentName({ client, wallet, parentLabel, agentLabel: "bob", records, waitForCommitment: async () => undefined }),
    ).rejects.toThrow(/already registered/);
  });
});
