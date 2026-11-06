// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ClearanceAccount} from "../src/ClearanceAccount.sol";
import {ClearanceHook} from "../src/ClearanceHook.sol";
import {ClearanceRouter} from "../src/ClearanceRouter.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {PlainToken} from "../src/test-support/TestTokens.sol";
import {TestUSDC} from "../src/test-support/TestUSDC.sol";

abstract contract Fixture is Test {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint128 internal constant AMOUNT = 1_000e6;

    uint256 internal agentPk = 0xA11CE;
    uint256 internal attackerPk = 0xBAD;
    uint256[3] internal verifierPks = [0xF1, 0xF2, 0xF3];
    address internal owner = makeAddr("owner");
    address internal agentKey;
    address internal attacker;

    PoolManager internal manager;
    PoolModifyLiquidityTest internal liquidity;
    VerifierSet internal verifiers;
    ClearanceHook internal hook;
    ClearanceRouter internal router;
    ClearanceAccount internal account;
    TestUSDC internal usdc;
    PlainToken internal token;
    PoolKey internal clearedPool;
    PoolKey internal outsidePool;

    function setUp() public virtual {
        agentKey = vm.addr(agentPk);
        attacker = vm.addr(attackerPk);

        manager = new PoolManager(address(this));
        liquidity = new PoolModifyLiquidityTest(manager);
        router = new ClearanceRouter(manager);

        address[] memory set = new address[](3);
        for (uint256 i; i < 3; i++) {
            set[i] = vm.addr(verifierPks[i]);
        }
        verifiers = new VerifierSet(owner, set, 2);

        bytes memory args = abi.encode(manager, verifiers, owner);
        (, bytes32 salt) =
            HookMiner.find(address(this), uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_INITIALIZE_FLAG), type(ClearanceHook).creationCode, args);
        hook = new ClearanceHook{salt: salt}(manager, verifiers, owner);
        vm.startPrank(owner);
        hook.setRouter(address(router), true);
        hook.setPoolCreator(address(this), true);
        vm.stopPrank();

        usdc = new TestUSDC(address(this), 1e15);
        token = new PlainToken("Token", "TKN", address(this), 1e15);
        account = new ClearanceAccount(owner, agentKey, verifiers, router, address(hook));

        vm.startPrank(owner);
        account.setSpendCap(address(usdc), 50_000e6);
        vm.stopPrank();

        clearedPool = _pool(IHooks(address(hook)));
        outsidePool = _pool(IHooks(address(0)));

        usdc.transfer(address(account), 100_000e6);
        token.transfer(attacker, 100_000e6);
        usdc.transfer(attacker, 100_000e6);
        vm.startPrank(attacker);
        usdc.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _pool(IHooks hooks) internal returns (PoolKey memory key) {
        (address a, address b) = address(usdc) < address(token)
            ? (address(usdc), address(token))
            : (address(token), address(usdc));
        key = PoolKey(Currency.wrap(a), Currency.wrap(b), 3000, 60, hooks);
        manager.initialize(key, SQRT_PRICE_1_1);
        usdc.approve(address(liquidity), type(uint256).max);
        token.approve(address(liquidity), type(uint256).max);
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(-6000, 6000, 1e13, 0), "");
    }

    function _zeroForOneFromUsdc() internal view returns (bool) {
        return Currency.unwrap(clearedPool.currency0) == address(usdc);
    }

    function _clearance(uint256 nonce) internal view returns (ClearanceHook.SwapClearance memory) {
        return ClearanceHook.SwapClearance({
            agent: address(account),
            poolId: PoolId.unwrap(clearedPool.toId()),
            zeroForOne: _zeroForOneFromUsdc(),
            maxAmountIn: AMOUNT,
            minAmountOut: 1,
            expiry: uint64(block.timestamp + 60),
            chainId: uint64(block.chainid),
            nonce: nonce,
            inputsHash: keccak256("inputs")
        });
    }

    /// @dev Signs with the given verifier keys, sorted by signer address as the contracts require.
    function _sign(bytes32 digest, uint256[] memory pks) internal view returns (bytes[] memory signatures) {
        for (uint256 i; i < pks.length; i++) {
            for (uint256 j = i + 1; j < pks.length; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
        signatures = new bytes[](pks.length);
        for (uint256 i; i < pks.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
            signatures[i] = abi.encodePacked(r, s, v);
        }
    }

    function _quorum() internal view returns (uint256[] memory pks) {
        pks = new uint256[](2);
        pks[0] = verifierPks[0];
        pks[1] = verifierPks[1];
    }

    function _hookData(ClearanceHook.SwapClearance memory c) internal view returns (bytes memory) {
        return abi.encode(c, _sign(hook.clearanceDigest(c), _quorum()));
    }

    function _expectHookRevert(bytes memory reason) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                reason,
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }

    function _swapAsAccount(bytes memory hookData) internal returns (uint256) {
        vm.prank(agentKey);
        return account.swapCleared(clearedPool, _zeroForOneFromUsdc(), AMOUNT, 0, hookData);
    }
}
