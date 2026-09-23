// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/CREIndexReceiver.sol";
import "../src/ComputeIndex.sol";

contract CREIndexReceiverTest is Test {
    ComputeIndex idx;
    CREIndexReceiver rx;
    address forwarder = address(0xF0);
    address wfOwner = address(0xB0B);

    function setUp() public {
        idx = new ComputeIndex();
        rx = new CREIndexReceiver(address(idx), forwarder);
        idx.setReporter(address(rx), true);
    }

    function _meta(address w) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes10("flopline"), w, bytes2(0));
    }

    function test_indexReportWritesIndex() public {
        vm.prank(forwarder);
        rx.onReport(_meta(wfOwner), abi.encode(uint8(0), bytes32("H100"), uint256(0), uint256(2_510_000)));
        (uint128 p,) = idx.latest("H100");
        assertEq(p, 2_510_000);
    }

    function test_settlementReportWritesSettlement() public {
        vm.prank(forwarder);
        rx.onReport(_meta(wfOwner), abi.encode(uint8(1), bytes32(0), uint256(7), uint256(2_600_000)));
        assertTrue(idx.hasSettlement(7));
        assertEq(idx.settlementPrice(7), 2_600_000);
    }

    function test_onlyForwarder() public {
        vm.expectRevert(CREIndexReceiver.NotForwarder.selector);
        rx.onReport(_meta(wfOwner), abi.encode(uint8(0), bytes32("H100"), uint256(0), uint256(1)));
    }

    function test_workflowOwnerCheck() public {
        rx.setExpectedWorkflowOwner(wfOwner);
        vm.prank(forwarder);
        rx.onReport(_meta(wfOwner), abi.encode(uint8(0), bytes32("H100"), uint256(0), uint256(1)));

        vm.prank(forwarder);
        vm.expectRevert(CREIndexReceiver.WrongWorkflowOwner.selector);
        rx.onReport(_meta(address(0xBAD)), abi.encode(uint8(0), bytes32("H100"), uint256(0), uint256(1)));
    }

    function test_badKindReverts() public {
        vm.prank(forwarder);
        vm.expectRevert(CREIndexReceiver.BadKind.selector);
        rx.onReport(_meta(wfOwner), abi.encode(uint8(9), bytes32(0), uint256(0), uint256(1)));
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(rx.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(rx.supportsInterface(0x01ffc9a7));
    }
}
