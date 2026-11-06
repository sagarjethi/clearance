// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";

/// @notice A minimal exact-input router that reports its real caller to hooks through IMsgSender.
contract ClearanceRouter is IUnlockCallback, IMsgSender {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    /// @dev An arbitrary fixed transient storage slot. Nothing else in this contract uses transient storage.
    bytes32 private constant CALLER_SLOT = 0xa3a0f6bc1f2a7e6d7d0e9b5e9d9f3c51b1f0a6d2c4e8b7a693d5f1e2c0b4a798;

    error NotPoolManager();
    error Reentered();
    error NativeNotSupported();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function msgSender() external view returns (address) {
        return _caller();
    }

    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 minOut,
        bytes calldata hookData,
        address recipient
    ) external returns (uint256 amountOut) {
        if (_caller() != address(0)) revert Reentered();
        _setCaller(msg.sender);
        amountOut = abi.decode(
            poolManager.unlock(abi.encode(key, zeroForOne, amountIn, minOut, hookData, recipient)), (uint256)
        );
        _setCaller(address(0));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (
            PoolKey memory key,
            bool zeroForOne,
            uint128 amountIn,
            uint128 minOut,
            bytes memory hookData,
            address recipient
        ) = abi.decode(data, (PoolKey, bool, uint128, uint128, bytes, address));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            hookData
        );

        (Currency currencyIn, Currency currencyOut, int128 deltaIn, int128 deltaOut) = zeroForOne
            ? (key.currency0, key.currency1, delta.amount0(), delta.amount1())
            : (key.currency1, key.currency0, delta.amount1(), delta.amount0());

        uint256 owed = uint256(uint128(-deltaIn));
        uint256 amountOut = uint256(uint128(deltaOut));
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        if (currencyIn.isAddressZero()) revert NativeNotSupported();

        poolManager.sync(currencyIn);
        IERC20(Currency.unwrap(currencyIn)).safeTransferFrom(_caller(), address(poolManager), owed);
        poolManager.settle();
        poolManager.take(currencyOut, recipient, amountOut);

        return abi.encode(amountOut);
    }

    function _caller() private view returns (address account) {
        assembly ("memory-safe") {
            account := tload(CALLER_SLOT)
        }
    }

    function _setCaller(address account) private {
        assembly ("memory-safe") {
            tstore(CALLER_SLOT, account)
        }
    }
}
