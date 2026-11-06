// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {VerifierSet} from "./VerifierSet.sol";

/// @notice A v4 hook for opt-in safe pools: no swap happens without a quorum-signed clearance.
/// A hook only guards its own pool, so ClearanceAccount is what stops an agent trading elsewhere.
contract ClearanceHook is IHooks, EIP712, Ownable {
    using PoolIdLibrary for PoolKey;

    struct SwapClearance {
        address agent;
        bytes32 poolId;
        bool zeroForOne;
        uint256 maxAmountIn;
        uint64 expiry;
        uint64 chainId;
        uint256 nonce;
        bytes32 inputsHash;
    }

    bytes32 public constant SWAP_CLEARANCE_TYPEHASH = keccak256(
        "SwapClearance(address agent,bytes32 poolId,bool zeroForOne,uint256 maxAmountIn,uint64 expiry,uint64 chainId,uint256 nonce,bytes32 inputsHash)"
    );

    IPoolManager public immutable poolManager;
    VerifierSet public immutable verifiers;

    mapping(address => bool) public isRouter;
    /// @dev Quoters revert every swap they make by design, so letting them through can't move funds.
    mapping(address => bool) public isQuoter;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    error NotPoolManager();
    error HookNotImplemented();
    error NoClearance();
    error RouterNotAllowed(address router);
    error WrongAgent(address caller, address agent);
    error WrongPool();
    error WrongDirection();
    error WrongChain();
    error ClearanceExpired();
    error ExactOutputNotClearable();
    error AmountAboveClearance(uint256 amountIn, uint256 maxAmountIn);
    error NonceUsed(uint256 nonce);
    error NoQuorum();

    event RouterSet(address indexed router, bool allowed);
    event QuoterSet(address indexed quoter, bool allowed);
    event SwapCleared(address indexed agent, bytes32 indexed poolId, uint256 nonce, uint256 amountIn, bytes32 inputsHash);

    constructor(IPoolManager poolManager_, VerifierSet verifiers_, address owner_)
        EIP712("Clearance", "1")
        Ownable(owner_)
    {
        poolManager = poolManager_;
        verifiers = verifiers_;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        isRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function setQuoter(address quoter, bool allowed) external onlyOwner {
        isQuoter[quoter] = allowed;
        emit QuoterSet(quoter, allowed);
    }

    function clearanceDigest(SwapClearance memory c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SWAP_CLEARANCE_TYPEHASH,
                    c.agent,
                    c.poolId,
                    c.zeroForOne,
                    c.maxAmountIn,
                    c.expiry,
                    c.chainId,
                    c.nonce,
                    c.inputsHash
                )
            )
        );
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        if (!isQuoter[sender]) _enforce(sender, key, params, hookData);

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _enforce(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        private
    {
        if (!isRouter[sender]) revert RouterNotAllowed(sender);
        if (hookData.length == 0) revert NoClearance();

        (SwapClearance memory c, bytes[] memory signatures) = abi.decode(hookData, (SwapClearance, bytes[]));

        address caller = IMsgSender(sender).msgSender();
        if (caller != c.agent) revert WrongAgent(caller, c.agent);

        if (c.poolId != PoolId.unwrap(key.toId())) revert WrongPool();
        if (c.zeroForOne != params.zeroForOne) revert WrongDirection();
        if (c.chainId != block.chainid) revert WrongChain();
        if (block.timestamp > c.expiry) revert ClearanceExpired();

        // beforeSwap can't bound the input of an exact-output swap, so it never gets cleared.
        if (params.amountSpecified >= 0) revert ExactOutputNotClearable();
        uint256 amountIn = uint256(-params.amountSpecified);
        if (amountIn > c.maxAmountIn) revert AmountAboveClearance(amountIn, c.maxAmountIn);

        if (nonceUsed[c.agent][c.nonce]) revert NonceUsed(c.nonce);
        nonceUsed[c.agent][c.nonce] = true;

        if (!verifiers.hasQuorum(clearanceDigest(c), signatures)) revert NoQuorum();

        emit SwapCleared(c.agent, c.poolId, c.nonce, amountIn, c.inputsHash);
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
