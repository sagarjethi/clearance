// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolIdLibrary, PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {ClearanceHook} from "../src/ClearanceHook.sol";
import {ClearanceRouter} from "../src/ClearanceRouter.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Fixture} from "./Fixture.sol";

contract SpoofingRouter is IMsgSender {
    address public claimed;

    function msgSender() external view returns (address) {
        return claimed;
    }

    function setClaimed(address claimed_) external {
        claimed = claimed_;
    }
}

contract ClearanceHookTest is Fixture {
    using PoolIdLibrary for PoolKey;

    function test_swapPassesWithQuorum() public {
        uint256 before = usdc.balanceOf(address(account));
        uint256 out = _swapAsAccount(_hookData(_clearance(1)));
        assertGt(out, 0);
        assertEq(usdc.balanceOf(address(account)), before - AMOUNT);
        assertEq(token.balanceOf(address(account)), out);
        assertTrue(hook.nonceUsed(address(account), 1));
    }

    function test_revertsWithoutClearance() public {
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NoClearance.selector));
        _swapAsAccount("");
    }

    function test_revertsWithOneSignature() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        uint256[] memory one = new uint256[](1);
        one[0] = verifierPks[0];
        bytes memory data = abi.encode(c, _sign(hook.clearanceDigest(c), one));
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NoQuorum.selector));
        _swapAsAccount(data);
    }

    function test_revertsWithDuplicateSignature() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        uint256[] memory one = new uint256[](1);
        one[0] = verifierPks[0];
        bytes[] memory single = _sign(hook.clearanceDigest(c), one);
        bytes[] memory twice = new bytes[](2);
        twice[0] = single[0];
        twice[1] = single[0];
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NoQuorum.selector));
        _swapAsAccount(abi.encode(c, twice));
    }

    function test_revertsWithUnsortedSignatures() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        bytes[] memory sorted = _sign(hook.clearanceDigest(c), _quorum());
        bytes[] memory reversed = new bytes[](2);
        reversed[0] = sorted[1];
        reversed[1] = sorted[0];
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NoQuorum.selector));
        _swapAsAccount(abi.encode(c, reversed));
    }

    function test_revertsWithOutsiderSignature() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        uint256[] memory pks = new uint256[](2);
        pks[0] = verifierPks[0];
        pks[1] = attackerPk;
        bytes memory data = abi.encode(c, _sign(hook.clearanceDigest(c), pks));
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NoQuorum.selector));
        _swapAsAccount(data);
    }

    function test_revertsAfterVerifierRemoved() public {
        bytes memory data = _hookData(_clearance(1));
        vm.prank(owner);
        verifiers.removeVerifier(vm.addr(verifierPks[0]));
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NoQuorum.selector));
        _swapAsAccount(data);
    }

    function test_revertsForCopiedClearanceFromAnotherCaller() public {
        bytes memory data = _hookData(_clearance(1));
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.WrongAgent.selector, attacker, address(account)));
        vm.prank(attacker);
        router.swapExactIn(clearedPool, _zeroForOneFromUsdc(), AMOUNT, 0, data, attacker);
    }

    function test_revertsForRouterNotAllowed() public {
        ClearanceRouter other = new ClearanceRouter(manager);
        bytes memory data = _hookData(_clearance(1));
        vm.startPrank(attacker);
        usdc.approve(address(other), type(uint256).max);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.RouterNotAllowed.selector, address(other)));
        other.swapExactIn(clearedPool, _zeroForOneFromUsdc(), AMOUNT, 0, data, attacker);
        vm.stopPrank();
    }

    function test_revertsOnReplay() public {
        bytes memory data = _hookData(_clearance(1));
        _swapAsAccount(data);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NonceUsed.selector, 1));
        _swapAsAccount(data);
    }

    function test_revertsForWrongPool() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        c.poolId = keccak256("other");
        bytes memory data = _hookData(c);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.WrongPool.selector));
        _swapAsAccount(data);
    }

    function test_revertsForWrongDirection() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        c.zeroForOne = !c.zeroForOne;
        bytes memory data = _hookData(c);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.WrongDirection.selector));
        _swapAsAccount(data);
    }

    function test_revertsForWrongChain() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        c.chainId = 999;
        bytes memory data = _hookData(c);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.WrongChain.selector));
        _swapAsAccount(data);
    }

    function test_revertsWhenExpired() public {
        bytes memory data = _hookData(_clearance(1));
        vm.warp(block.timestamp + 61);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.ClearanceExpired.selector));
        _swapAsAccount(data);
    }

    function test_revertsAboveClearedAmount_soReduceIsEnforced() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        c.maxAmountIn = AMOUNT - 1;
        bytes memory data = _hookData(c);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.AmountAboveClearance.selector, AMOUNT, AMOUNT - 1));
        _swapAsAccount(data);
    }

    function test_swapBelowClearedAmountPasses() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        c.maxAmountIn = AMOUNT + 1;
        assertGt(_swapAsAccount(_hookData(c)), 0);
    }

    function test_tamperedFieldFailsQuorum() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        bytes[] memory signatures = _sign(hook.clearanceDigest(c), _quorum());
        c.inputsHash = keccak256("different inputs");
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NoQuorum.selector));
        _swapAsAccount(abi.encode(c, signatures));
    }

    function test_garbageHookDataReverts() public {
        vm.expectRevert();
        _swapAsAccount(hex"deadbeef");
    }

    function test_quoterQuotesWithoutClearanceAndCannotMoveFunds() public {
        V4Quoter quoter = new V4Quoter(manager);
        IV4Quoter.QuoteExactSingleParams memory params =
            IV4Quoter.QuoteExactSingleParams(clearedPool, _zeroForOneFromUsdc(), AMOUNT, "");

        vm.expectRevert();
        quoter.quoteExactInputSingle(params);

        vm.prank(owner);
        hook.setQuoter(address(quoter), true);
        uint256 usdcBefore = usdc.balanceOf(address(manager));
        (uint256 out,) = quoter.quoteExactInputSingle(params);
        assertGt(out, 0);
        assertEq(usdc.balanceOf(address(manager)), usdcBefore);
    }

    function test_strangerCantOpenAPoolOnTheHook() public {
        PoolKey memory key = PoolKey(clearedPool.currency0, clearedPool.currency1, 500, 10, clearedPool.hooks);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(ClearanceHook.PoolCreatorNotAllowed.selector, attacker),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_ownerCanOpenAPool() public {
        PoolKey memory key = PoolKey(clearedPool.currency0, clearedPool.currency1, 500, 10, clearedPool.hooks);
        vm.prank(owner);
        manager.initialize(key, SQRT_PRICE_1_1);
    }
}
