// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/ComputeExchange.sol";
import "../src/ComputeIndex.sol";
import "../src/MockUSDC.sol";
import "../src/PairMinter.sol";

contract PairMinterTest is Test {
    MockUSDC usdc;
    ComputeIndex idx;
    ComputeExchange ex;
    PairMinter pm;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 closeTime;
    uint256 settleTime;
    uint256 constant MAX = 1000 * 10_000; // $10.00 in 6dp

    function setUp() public {
        usdc = new MockUSDC();
        idx = new ComputeIndex();
        ex = new ComputeExchange(address(usdc), address(idx));
        pm = new PairMinter(address(usdc), address(ex));
        closeTime = block.timestamp + 7 days;
        settleTime = closeTime + 7 days;
        ex.createMarket("H100", uint64(closeTime), uint64(settleTime), 1000, 10_000, 0, 0);
        usdc.mint(alice, 100_000e6);
        vm.prank(alice);
        usdc.approve(address(pm), type(uint256).max);
    }

    function _settle(uint256 price) internal {
        vm.warp(settleTime);
        idx.reportSettlement(1, price);
        ex.settle(1);
    }

    function test_mintLocksMaxPriceAndIssuesBothSides() public {
        vm.prank(alice);
        pm.mint(1, 10e6); // 10 GPU-hours
        (PositionToken l, PositionToken s) = pm.pairs(1);
        assertEq(l.balanceOf(alice), 10e6);
        assertEq(s.balanceOf(alice), 10e6);
        assertEq(usdc.balanceOf(address(pm)), 10 * MAX); // 10 hours * $10.00
        assertEq(l.symbol(), "fL1");
    }

    function test_mergeReturnsCollateral() public {
        vm.startPrank(alice);
        pm.mint(1, 10e6);
        uint256 before = usdc.balanceOf(alice);
        pm.merge(1, 4e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice) - before, 4 * MAX);
    }

    function test_settlementPaysEachSide() public {
        vm.prank(alice);
        pm.mint(1, 10e6);
        (PositionToken l,) = pm.pairs(1);
        vm.prank(alice);
        l.transfer(bob, 10e6); // bob holds the long, alice keeps the short

        _settle(3_000_000); // $3.00
        vm.prank(bob);
        assertEq(pm.redeem(1, true, 10e6), 10 * 3_000_000);
        vm.prank(alice);
        assertEq(pm.redeem(1, false, 10e6), 10 * (MAX - 3_000_000));
        assertEq(usdc.balanceOf(address(pm)), 0);
    }

    function test_cannotMintAfterClose() public {
        vm.warp(closeTime);
        vm.prank(alice);
        vm.expectRevert(PairMinter.MarketClosed.selector);
        pm.mint(1, 1e6);
    }

    function test_cannotRedeemBeforeSettlement() public {
        vm.prank(alice);
        pm.mint(1, 1e6);
        vm.prank(alice);
        vm.expectRevert(PairMinter.NotSettled.selector);
        pm.redeem(1, true, 1e6);
    }

    function test_unknownMarketReverts() public {
        vm.prank(alice);
        vm.expectRevert(PairMinter.UnknownMarket.selector);
        pm.mint(99, 1e6);
    }

    /// Redemptions never exceed collateral, for any amount and settlement price.
    function testFuzz_solvent(uint256 amount, uint256 price) public {
        amount = bound(amount, 1, 1_000_000e6);
        price = bound(price, 0, MAX);
        usdc.mint(alice, amount * MAX / 1e6 + 1e6);
        vm.startPrank(alice);
        pm.mint(1, amount);
        uint256 spent = usdc.balanceOf(address(pm));
        vm.stopPrank();

        _settle(price);
        vm.startPrank(alice);
        uint256 a = pm.redeem(1, true, amount);
        uint256 b = pm.redeem(1, false, amount);
        vm.stopPrank();

        assertLe(a + b, spent);
        assertLe(spent - (a + b), 2); // rounding dust only
    }
}
