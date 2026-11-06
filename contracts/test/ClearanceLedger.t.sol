// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ClearanceHook} from "../src/ClearanceHook.sol";
import {ClearanceLedger} from "../src/ClearanceLedger.sol";
import {Fixture} from "./Fixture.sol";

contract ClearanceLedgerTest is Fixture {
    using PoolIdLibrary for PoolKey;

    address private forwarder = makeAddr("forwarder");
    ClearanceLedger private ledger;
    bytes32 private poolId;

    function setUp() public override {
        super.setUp();
        ledger = new ClearanceLedger(owner, forwarder);
        poolId = PoolId.unwrap(clearedPool.toId());
        vm.startPrank(owner);
        hook.setLedger(ledger);
        hook.setAttestAbove(poolId, AMOUNT - 1);
        vm.stopPrank();
    }

    function _report(bytes32 digest, uint8 status) private {
        vm.prank(forwarder);
        ledger.onReport("", abi.encode(digest, status, uint32(12), keccak256("inputs")));
    }

    function test_largeSwapRevertsWithoutAttestation() public {
        bytes memory data = _hookData(_clearance(1));
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NotAttested.selector));
        _swapAsAccount(data);
    }

    function test_largeSwapPassesOnceAttested() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        _report(hook.clearanceDigest(c), 1);
        assertGt(_swapAsAccount(_hookData(c)), 0);
    }

    function test_refusedAttestationStillBlocks() public {
        ClearanceHook.SwapClearance memory c = _clearance(1);
        _report(hook.clearanceDigest(c), 2);
        bytes memory data = _hookData(c);
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NotAttested.selector));
        _swapAsAccount(data);
    }

    function test_attestationForAnotherClearanceDoesNotCount() public {
        _report(hook.clearanceDigest(_clearance(2)), 1);
        bytes memory data = _hookData(_clearance(1));
        _expectHookRevert(abi.encodeWithSelector(ClearanceHook.NotAttested.selector));
        _swapAsAccount(data);
    }

    function test_smallSwapNeedsNoAttestation() public {
        vm.prank(owner);
        hook.setAttestAbove(poolId, AMOUNT);
        assertGt(_swapAsAccount(_hookData(_clearance(1))), 0);
    }

    function test_onlyForwarderReports() public {
        vm.expectRevert(abi.encodeWithSelector(ClearanceLedger.NotForwarder.selector, address(this)));
        ledger.onReport("", abi.encode(bytes32(0), uint8(1), uint32(0), bytes32(0)));
    }

    function test_firstReportStands() public {
        _report(keccak256("d"), 2);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ClearanceLedger.AlreadyReported.selector, keccak256("d")));
        ledger.onReport("", abi.encode(keccak256("d"), uint8(1), uint32(0), bytes32(0)));
    }

    function test_rejectsInvalidStatus() public {
        vm.prank(forwarder);
        vm.expectRevert(ClearanceLedger.InvalidStatus.selector);
        ledger.onReport("", abi.encode(bytes32(0), uint8(0), uint32(0), bytes32(0)));
    }

    function test_workflowPinning() public {
        vm.prank(owner);
        ledger.setExpectedWorkflow(keccak256("wf"));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ClearanceLedger.WrongWorkflow.selector, bytes32(0)));
        ledger.onReport("", abi.encode(keccak256("d"), uint8(1), uint32(0), bytes32(0)));

        vm.prank(forwarder);
        ledger.onReport(abi.encodePacked(keccak256("wf")), abi.encode(keccak256("d"), uint8(1), uint32(0), bytes32(0)));
        assertTrue(ledger.isAttested(keccak256("d")));
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(ledger.supportsInterface(ledger.onReport.selector));
    }
}
