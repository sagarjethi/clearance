// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {VerifierSet} from "../src/VerifierSet.sol";

contract VerifierSetTest is Test {
    VerifierSet private set;
    address private a = makeAddr("a");
    address private b = makeAddr("b");

    function setUp() public {
        address[] memory initial = new address[](2);
        initial[0] = a;
        initial[1] = b;
        set = new VerifierSet(address(this), initial, 2);
    }

    function test_thresholdCantExceedVerifiers() public {
        vm.expectRevert(VerifierSet.InvalidThreshold.selector);
        set.setThreshold(3);
    }

    function test_thresholdCantBeZero() public {
        vm.expectRevert(VerifierSet.InvalidThreshold.selector);
        set.setThreshold(0);
    }

    function test_cantRemoveBelowThreshold() public {
        vm.expectRevert(VerifierSet.InvalidThreshold.selector);
        set.removeVerifier(a);
    }

    function test_cantAddTwice() public {
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.AlreadyVerifier.selector, a));
        set.addVerifier(a);
    }

    function test_onlyOwnerChangesSet() public {
        vm.prank(a);
        vm.expectRevert();
        set.addVerifier(makeAddr("c"));
    }
}
