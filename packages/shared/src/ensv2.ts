import {
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  keccak256,
  namehash,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { RECORD_KEYS, type RawRecords } from "./limits";

/** ENSv2 on Sepolia, from contracts-v2 tag v2-mainnet-deployment-1. That repo's main branch has moved on. */
export const ENSV2_SEPOLIA = {
  ethRegistrar: "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3",
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  verifiableFactory: "0xda70306c98e97ece36f997a21368e53298572991",
  userRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
  permissionedResolverImpl: "0x115eb53f0c60696633855f90b138178fb40b2b2c",
  universalResolver: "0x24e1d8e068620b647ca097f961a61055f4f42d72",
  paymentToken: "0x240b0316df57887dbbe58b586508b19e633a14aa",
} as const;

const ROLE = {
  registrar: 1n << 0n,
  setParent: 1n << 8n,
  setSubregistry: 1n << 20n,
  setResolver: 1n << 24n,
};
const admin = (role: bigint) => role << 128n;
const RESOLVER_SET_TEXT = 1n << 4n;

/** Everything an owner needs, apart from the right to transfer the name. A limits name stays with its agent. */
const OWNER_ROLES =
  ROLE.setSubregistry | admin(ROLE.setSubregistry) | ROLE.setResolver | admin(ROLE.setResolver);
const REGISTRY_ROOT_ROLES =
  ROLE.registrar | admin(ROLE.registrar) | ROLE.setParent | admin(ROLE.setParent);

export const ensv2Abi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
  "function initialize((address account, uint256 roleBitmap)[] grants)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256, uint256)",
  "function isAvailable(string label) view returns (bool)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function setParent(address parent, string label)",
  "function setSubregistry(uint256 anyId, address registry)",
]);

const registryRegisterAbi = parseAbi([
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
]);

const resolverInitAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
]);

export const permissionedResolverAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
]);

/** DNS wire format, which ENSv2's resolver setters take instead of a namehash. */
export function dnsEncodeName(name: string): Hex {
  const parts = name.split(".").flatMap((label) => {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`Invalid label in ${name}`);
    return [bytes.length, ...bytes];
  });
  return toHex(new Uint8Array([...parts, 0]));
}

export const resolveAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);

/** ENSv2 resolvers answer only through ENSIP-10's `resolve`, so this is the one way records get read. */
export function textLookupArgs(name: string, key: string): readonly [Hex, Hex] {
  return [
    dnsEncodeName(name),
    encodeFunctionData({ abi: resolveAbi, functionName: "text", args: [namehash(name), key] }),
  ];
}

export function decodeTextLookup(result: Hex): string {
  return decodeFunctionResult({ abi: resolveAbi, functionName: "text", data: result });
}

export async function readAgentRecords(client: PublicClient, resolver: Address, name: string): Promise<RawRecords> {
  const entries = await Promise.all(
    Object.entries(RECORD_KEYS).map(async ([field, key]) => {
      const result = await client.readContract({
        address: resolver,
        abi: resolveAbi,
        functionName: "resolve",
        args: textLookupArgs(name, key),
      });
      return [field, decodeTextLookup(result)] as const;
    }),
  );
  return Object.fromEntries(entries) as RawRecords;
}

export type EnsSetupOptions = {
  client: PublicClient;
  wallet: WalletClient;
  /** The parent to register, without .eth. */
  parentLabel: string;
  agentLabel: string;
  records: RawRecords;
  /** Waits out the registrar's commit period. A fork can skip time, a real network has to wait. */
  waitForCommitment: (seconds: number) => Promise<void>;
  salt?: bigint;
  durationSeconds?: bigint;
  log?: (message: string) => void;
};

export type EnsSetupResult = { name: string; node: Hex; resolver: Address; registry: Address };

/**
 * Creates `<agent>.<parent>.eth` on ENSv2 with its own resolver and writes the agent's limits.
 * One resolver per agent, because a key-scoped writer can write that key for every name on a resolver.
 */
export async function setupAgentName(options: EnsSetupOptions): Promise<EnsSetupResult> {
  const { client, wallet, parentLabel, agentLabel, records, log = () => undefined } = options;
  const account = wallet.account;
  if (!account) throw new Error("The wallet needs an account");
  const owner = account.address;
  const salt = options.salt ?? BigInt(keccak256(stringToHex(`clearance:${parentLabel}:${agentLabel}`)));
  const duration = options.durationSeconds ?? 365n * 24n * 3600n;
  const send = async (hash: Promise<Hex>) => {
    const receipt = await client.waitForTransactionReceipt({ hash: await hash });
    if (receipt.status !== "success") throw new Error(`Transaction ${receipt.transactionHash} reverted`);
    return receipt;
  };
  const write = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) =>
    send(wallet.writeContract({ address, abi: abi as never, functionName, args, account, chain: wallet.chain } as never));

  const E = ENSV2_SEPOLIA;
  if (!(await client.readContract({ address: E.ethRegistrar, abi: ensv2Abi, functionName: "isAvailable", args: [parentLabel] }))) {
    throw new Error(`${parentLabel}.eth is already registered. Choose another parent label.`);
  }

  const deployProxy = async (implementation: Address, data: Hex, proxySalt: bigint): Promise<Address> => {
    const receipt = await write(E.verifiableFactory, ensv2Abi, "deployProxy", [implementation, proxySalt, data]);
    const log0 = receipt.logs.find((l) => l.address.toLowerCase() === E.verifiableFactory);
    const proxy = log0?.topics[2];
    if (!proxy) throw new Error("The factory reported no proxy address");
    return `0x${proxy.slice(-40)}` as Address;
  };

  log("Deploying the agent's resolver");
  const resolver = await deployProxy(
    E.permissionedResolverImpl,
    encodeFunctionData({
      abi: resolverInitAbi,
      functionName: "initialize",
      args: [[{ roleBitmap: RESOLVER_SET_TEXT | admin(RESOLVER_SET_TEXT), account: owner }], []],
    }),
    salt,
  );

  log("Deploying the parent's registry");
  const registry = await deployProxy(
    E.userRegistryImpl,
    encodeFunctionData({
      abi: ensv2Abi,
      functionName: "initialize",
      args: [[{ roleBitmap: REGISTRY_ROOT_ROLES, account: owner }]],
    }),
    salt + 1n,
  );

  log(`Registering ${parentLabel}.eth`);
  const secret = keccak256(encodePacked(["uint256", "address"], [salt, owner]));
  const referrer = `0x${"00".repeat(32)}` as Hex;
  const commitment = await client.readContract({
    address: E.ethRegistrar,
    abi: ensv2Abi,
    functionName: "makeCommitment",
    args: [parentLabel, owner, secret, registry, resolver, duration, referrer],
  });
  await write(E.ethRegistrar, ensv2Abi, "commit", [commitment]);
  const age = await client.readContract({ address: E.ethRegistrar, abi: ensv2Abi, functionName: "MIN_COMMITMENT_AGE" });
  await options.waitForCommitment(Number(age) + 1);

  const [base, premium] = await client.readContract({
    address: E.ethRegistrar,
    abi: ensv2Abi,
    functionName: "getRegisterPrice",
    args: [parentLabel, duration, E.paymentToken],
  });
  const price = base + premium;
  await write(E.paymentToken, ensv2Abi, "mint", [owner, price]);
  await write(E.paymentToken, ensv2Abi, "approve", [E.ethRegistrar, price]);
  await write(E.ethRegistrar, ensv2Abi, "register", [parentLabel, owner, secret, registry, resolver, duration, E.paymentToken, referrer]);

  await write(registry, ensv2Abi, "setParent", [E.ethRegistry, parentLabel]);

  log(`Registering ${agentLabel}.${parentLabel}.eth`);
  const block = await client.getBlock();
  await write(registry, registryRegisterAbi, "register", [
    agentLabel,
    owner,
    "0x0000000000000000000000000000000000000000",
    resolver,
    OWNER_ROLES,
    block.timestamp + duration,
  ]);

  const name = `${agentLabel}.${parentLabel}.eth`;
  const dnsName = dnsEncodeName(name);
  log("Writing the agent's limits");
  for (const [field, key] of Object.entries(RECORD_KEYS)) {
    await write(resolver, permissionedResolverAbi, "setText", [dnsName, key, records[field as keyof RawRecords]]);
  }

  return { name, node: namehash(name), resolver, registry };
}

/** Lets `operator` write one record and nothing else, for example a risk desk that tunes one limit. */
export async function grantRecordWriter(
  client: PublicClient,
  wallet: WalletClient,
  resolver: Address,
  name: string,
  key: string,
  operator: Address,
): Promise<void> {
  const setter = encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: "setText",
    args: [dnsEncodeName(name), key, ""],
  });
  const hash = await wallet.writeContract({
    address: resolver,
    abi: permissionedResolverAbi,
    functionName: "grantSetterRoles",
    args: [setter, operator],
    account: wallet.account!,
    chain: wallet.chain,
  });
  await client.waitForTransactionReceipt({ hash });
}
