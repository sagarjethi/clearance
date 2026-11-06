// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ClearanceAccount} from "../src/ClearanceAccount.sol";
import {TestUSDC} from "../src/test-support/TestUSDC.sol";
import {RugToken} from "../src/test-support/TestTokens.sol";
import {Fixture} from "./Fixture.sol";

contract ClearanceAccountTest is Fixture {
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes4 private constant INVALID = 0xffffffff;
    address private payee = makeAddr("payee");

    function test_agentCannotTradeOutsidePool() public {
        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(ClearanceAccount.PoolNotCleared.selector, address(0)));
        account.swapCleared(outsidePool, _zeroForOneFromUsdc(), AMOUNT, 0, "");
    }

    function test_agentCannotMoveTokensDirectly() public {
        vm.prank(agentKey);
        vm.expectRevert(ClearanceAccount.NotOwner.selector);
        account.execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (attacker, 1)));
        assertEq(usdc.balanceOf(attacker), 100_000e6);
    }

    function test_strangerCannotSwap() public {
        vm.prank(attacker);
        vm.expectRevert(ClearanceAccount.NotAgent.selector);
        account.swapCleared(clearedPool, _zeroForOneFromUsdc(), AMOUNT, 0, "");
    }

    function test_noApprovalLeftAfterSwap() public {
        _swapAsAccount(_hookData(_clearance(1)));
        assertEq(usdc.allowance(address(account), address(router)), 0);
    }

    function test_ownerCanRecoverFunds() public {
        vm.prank(owner);
        account.execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, 5)));
        assertEq(usdc.balanceOf(owner), 5);
    }

    function test_ownerCanRotateAgentKey() public {
        vm.prank(owner);
        account.setAgentKey(attacker);
        vm.prank(agentKey);
        vm.expectRevert(ClearanceAccount.NotAgent.selector);
        account.swapCleared(clearedPool, true, AMOUNT, 0, "");
    }

    function _authDigest(address to, uint256 value, uint256 validBefore, bytes32 nonce) private view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(account), to, value, 0, validBefore, nonce))
        );
    }

    function _packed(bytes32 digest, uint256 pk, uint256[] memory verifierKeys) private view returns (bytes memory packed) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        packed = abi.encodePacked(r, s, v);
        bytes[] memory signatures = _sign(account.paymentDigest(digest), verifierKeys);
        for (uint256 i; i < signatures.length; i++) {
            packed = bytes.concat(packed, signatures[i]);
        }
    }

    function test_1271AcceptsAgentPlusQuorum() public view {
        bytes32 digest = keccak256("anything");
        assertEq(account.isValidSignature(digest, _packed(digest, agentPk, _quorum())), MAGIC);
    }

    function test_1271RefusesAgentAlone() public view {
        bytes32 digest = keccak256("anything");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        assertEq(account.isValidSignature(digest, abi.encodePacked(r, s, v)), INVALID);
    }

    function test_1271RefusesOneVerifier() public view {
        bytes32 digest = keccak256("anything");
        uint256[] memory one = new uint256[](1);
        one[0] = verifierPks[0];
        assertEq(account.isValidSignature(digest, _packed(digest, agentPk, one)), INVALID);
    }

    function test_1271RefusesWrongAgent() public view {
        bytes32 digest = keccak256("anything");
        assertEq(account.isValidSignature(digest, _packed(digest, attackerPk, _quorum())), INVALID);
    }

    function test_1271RefusesVerifiersWhoSignedAnotherDigest() public view {
        bytes32 digest = keccak256("anything");
        bytes memory packed = _packed(keccak256("something else"), agentPk, _quorum());
        assertEq(account.isValidSignature(digest, packed), INVALID);
    }

    function test_1271RefusesBadLengths() public view {
        bytes32 digest = keccak256("anything");
        assertEq(account.isValidSignature(digest, ""), INVALID);
        assertEq(account.isValidSignature(digest, hex"00"), INVALID);
        assertEq(account.isValidSignature(digest, new bytes(66)), INVALID);
        assertEq(account.isValidSignature(digest, new bytes(130)), INVALID);
    }

    function test_paymentSettlesOnceWithQuorum() public {
        uint256 validBefore = block.timestamp + 60;
        bytes32 nonce = keccak256("pay-1");
        bytes memory signature = _packed(_authDigest(payee, 10_000, validBefore, nonce), agentPk, _quorum());

        usdc.transferWithAuthorization(address(account), payee, 10_000, 0, validBefore, nonce, signature);
        assertEq(usdc.balanceOf(payee), 10_000);

        vm.expectRevert(TestUSDC.AuthorizationAlreadyUsed.selector);
        usdc.transferWithAuthorization(address(account), payee, 10_000, 0, validBefore, nonce, signature);
    }

    function test_paymentToAnotherPayeeIsRefused() public {
        uint256 validBefore = block.timestamp + 60;
        bytes32 nonce = keccak256("pay-1");
        bytes memory signature = _packed(_authDigest(payee, 10_000, validBefore, nonce), agentPk, _quorum());

        vm.expectRevert(TestUSDC.InvalidAuthorization.selector);
        usdc.transferWithAuthorization(address(account), attacker, 10_000, 0, validBefore, nonce, signature);
    }

    function test_paymentWithAgentKeyAloneIsRefused() public {
        uint256 validBefore = block.timestamp + 60;
        bytes32 nonce = keccak256("pay-1");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _authDigest(payee, 10_000, validBefore, nonce));

        vm.expectRevert(TestUSDC.InvalidAuthorization.selector);
        usdc.transferWithAuthorization(address(account), payee, 10_000, 0, validBefore, nonce, abi.encodePacked(r, s, v));
    }
}
