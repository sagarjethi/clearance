import { parseAbi } from "viem";

export const resolverAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function setText(bytes32 node, string key, string value)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);

export const verifierSetAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function verifierCount() view returns (uint256)",
  "function isVerifier(address) view returns (bool)",
  "function removeVerifier(address)",
  "function hasQuorum(bytes32 digest, bytes[] signatures) view returns (bool)",
]);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

export const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const accountAbi = [
  {
    type: "function",
    name: "swapCleared",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "minOut", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "digest", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
  {
    type: "function",
    name: "paymentDigest",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "spendRemaining",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "agentKey",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  { type: "error", name: "TooFewSignatures", inputs: [{ name: "given", type: "uint256" }, { name: "required", type: "uint256" }] },
  {
    type: "error",
    name: "SpendCapExceeded",
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "remaining", type: "uint256" }],
  },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NotAgent", inputs: [] },
  { type: "error", name: "PoolNotCleared", inputs: [{ name: "hook", type: "address" }] },
  { type: "error", name: "CallFailed", inputs: [{ name: "returnData", type: "bytes" }] },
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "minOut", type: "uint128" },
      { name: "hookData", type: "bytes" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const hookAbi = parseAbi([
  "function clearanceDigest((address agent,bytes32 poolId,bool zeroForOne,uint256 maxAmountIn,uint256 minAmountOut,uint64 expiry,uint64 chainId,uint256 nonce,bytes32 inputsHash) c) view returns (bytes32)",
  "function nonceUsed(address,uint256) view returns (bool)",
  "function attestAbove(bytes32) view returns (uint256)",
  "error NotAttested()",
  "error PoolCreatorNotAllowed(address creator)",
  "error NoClearance()",
  "error RouterNotAllowed(address router)",
  "error WrongAgent(address caller, address agent)",
  "error WrongPool()",
  "error WrongDirection()",
  "error WrongChain()",
  "error ClearanceExpired()",
  "error ExactOutputNotClearable()",
  "error AmountAboveClearance(uint256 amountIn, uint256 maxAmountIn)",
  "error NonceUsed(uint256 nonce)",
  "error NoQuorum()",
]);
