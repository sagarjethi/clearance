// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ClearanceHook} from "./ClearanceHook.sol";
import {ClearanceRouter} from "./ClearanceRouter.sol";
import {VerifierSet} from "./VerifierSet.sol";

/// @notice The agent's wallet, and the real enforcer. The agent key can only swap through pools guarded
/// by an allowed hook, and any signature it makes needs verifier signatures to be valid.
/// It has no function that lets the agent key move tokens directly.
contract ClearanceAccount is IERC1271, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant PAYMENT_CLEARANCE_TYPEHASH = keccak256("PaymentClearance(bytes32 digest)");
    bytes4 private constant MAGIC_VALUE = IERC1271.isValidSignature.selector;
    bytes4 private constant INVALID = 0xffffffff;
    uint256 private constant SIGNATURE_LENGTH = 65;

    address public immutable owner;
    VerifierSet public immutable verifiers;
    ClearanceRouter public immutable router;

    uint256 public constant SPEND_WINDOW = 1 days;

    address public agentKey;
    mapping(address => bool) public isAllowedHook;
    /// @notice The owner can require more signatures than the shared set does, never fewer.
    uint256 public minSignatures;

    /// @notice The most of each token the agent key can spend per window. No cap set means none at all.
    mapping(address => uint256) public spendCap;
    mapping(address => uint256) private spentInWindow;
    mapping(address => uint256) private windowStart;

    error NotOwner();
    error NotAgent();
    error PoolNotCleared(address hook);
    error CallFailed(bytes returnData);
    error TooFewSignatures(uint256 given, uint256 required);
    error SpendCapExceeded(address token, uint256 amount, uint256 remaining);

    event AgentKeySet(address indexed agentKey);
    event AllowedHookSet(address indexed hook, bool allowed);
    event MinSignaturesSet(uint256 minSignatures);
    event SpendCapSet(address indexed token, uint256 cap);
    event ClearedSwap(address indexed hook, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address agentKey_, VerifierSet verifiers_, ClearanceRouter router_, address hook)
        EIP712("ClearanceAccount", "1")
    {
        owner = owner_;
        agentKey = agentKey_;
        verifiers = verifiers_;
        router = router_;
        isAllowedHook[hook] = true;
        emit AgentKeySet(agentKey_);
        emit AllowedHookSet(hook, true);
    }

    receive() external payable {}

    function setAgentKey(address agentKey_) external onlyOwner {
        agentKey = agentKey_;
        emit AgentKeySet(agentKey_);
    }

    function setAllowedHook(address hook, bool allowed) external onlyOwner {
        isAllowedHook[hook] = allowed;
        emit AllowedHookSet(hook, allowed);
    }

    function setMinSignatures(uint256 minSignatures_) external onlyOwner {
        minSignatures = minSignatures_;
        emit MinSignaturesSet(minSignatures_);
    }

    function setSpendCap(address token, uint256 cap) external onlyOwner {
        spendCap[token] = cap;
        emit SpendCapSet(token, cap);
    }

    /// @notice What the agent key can still spend of `token` in the current window.
    function spendRemaining(address token) public view returns (uint256) {
        uint256 spent = block.timestamp >= windowStart[token] + SPEND_WINDOW ? 0 : spentInWindow[token];
        uint256 cap = spendCap[token];
        return spent >= cap ? 0 : cap - spent;
    }

    /// @notice The owner's escape hatch. The agent key can't call this.
    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory returnData) = target.call{value: value}(data);
        if (!ok) revert CallFailed(returnData);
        return returnData;
    }

    /// @notice The only way the agent key can move funds. The hook checks the clearance in `hookData`, and
    /// this enforces what a hook can't: the signed minimum output, a rolling spend cap and the owner's quorum.
    function swapCleared(PoolKey calldata key, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes calldata hookData)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != agentKey) revert NotAgent();
        if (!isAllowedHook[address(key.hooks)]) revert PoolNotCleared(address(key.hooks));

        IERC20 tokenIn = IERC20(Currency.unwrap(zeroForOne ? key.currency0 : key.currency1));

        uint256 remaining = spendRemaining(address(tokenIn));
        if (amountIn > remaining) revert SpendCapExceeded(address(tokenIn), amountIn, remaining);
        if (block.timestamp >= windowStart[address(tokenIn)] + SPEND_WINDOW) {
            windowStart[address(tokenIn)] = block.timestamp;
            spentInWindow[address(tokenIn)] = 0;
        }
        spentInWindow[address(tokenIn)] += amountIn;

        // Empty hookData falls through, so the hook itself reports the missing clearance.
        uint256 floor = minOut;
        if (hookData.length != 0) {
            (ClearanceHook.SwapClearance memory c, bytes[] memory signatures) =
                abi.decode(hookData, (ClearanceHook.SwapClearance, bytes[]));
            if (signatures.length < minSignatures) revert TooFewSignatures(signatures.length, minSignatures);
            if (c.maxAmountIn != 0) {
                // A smaller trade than cleared has to get at least its share of the signed output.
                uint256 signedFloor = Math.mulDiv(c.minAmountOut, amountIn, c.maxAmountIn);
                if (signedFloor > floor) floor = signedFloor;
            }
        }

        tokenIn.forceApprove(address(router), amountIn);
        amountOut = router.swapExactIn(key, zeroForOne, amountIn, uint128(floor), hookData, address(this));
        tokenIn.forceApprove(address(router), 0);

        emit ClearedSwap(address(key.hooks), zeroForOne, amountIn, amountOut);
    }

    function paymentDigest(bytes32 digest) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PAYMENT_CLEARANCE_TYPEHASH, digest)));
    }

    /// @notice `signature` is the agent key's 65-byte signature over `digest`, followed by verifier
    /// signatures over PaymentClearance(digest), sorted by signer.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length <= SIGNATURE_LENGTH || signature.length % SIGNATURE_LENGTH != 0) return INVALID;

        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature[:SIGNATURE_LENGTH]);
        if (err != ECDSA.RecoverError.NoError || signer != agentKey) return INVALID;

        uint256 count = signature.length / SIGNATURE_LENGTH - 1;
        if (count < minSignatures) return INVALID;
        bytes[] memory verifierSignatures = new bytes[](count);
        for (uint256 i; i < count; i++) {
            uint256 start = SIGNATURE_LENGTH * (i + 1);
            verifierSignatures[i] = signature[start:start + SIGNATURE_LENGTH];
        }

        return verifiers.hasQuorum(paymentDigest(digest), verifierSignatures) ? MAGIC_VALUE : INVALID;
    }
}
