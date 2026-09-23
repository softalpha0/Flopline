// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/EquityStreamVault.sol";
import "../src/MockEquity.sol";
import "../src/MockUSDC.sol";

contract EquityStreamVaultTest is Test {
    MockUSDC usdc;
    MockEquity equity;
    EquityStreamVault vault;

    address alice = address(0xA11CE); // seller
    address bob = address(0xB0B); // buyer

    function setUp() public {
        usdc = new MockUSDC();
        equity = new MockEquity("Tokenized NVDA (mock)", "mNVDA");
        vault = new EquityStreamVault(address(usdc));

        equity.mint(alice, 1_000e18);
        vm.prank(alice);
        equity.approve(address(vault), type(uint256).max);

        usdc.mint(bob, 1_000_000e6);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _list(uint128 amount, uint64 start, uint64 end, uint128 price) internal returns (uint256 id) {
        vm.prank(alice);
        return vault.list(address(equity), amount, start, end, price);
    }

    function test_listLocksTokens() public {
        uint256 before = equity.balanceOf(alice);
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 30 days), 5_000e6);
        assertEq(equity.balanceOf(alice), before - 100e18);
        assertEq(equity.balanceOf(address(vault)), 100e18);
        (,, address buyer,,,,, uint128 ask) = vault.streams(id);
        assertEq(buyer, address(0));
        assertEq(ask, 5_000e6);
    }

    function test_badScheduleReverts() public {
        vm.startPrank(alice);
        vm.expectRevert(EquityStreamVault.BadSchedule.selector);
        vault.list(address(equity), 100e18, uint64(block.timestamp + 1), uint64(block.timestamp), 1); // end <= start
        vm.expectRevert(EquityStreamVault.BadSchedule.selector);
        vault.list(address(equity), 0, uint64(block.timestamp), uint64(block.timestamp + 1), 1); // zero amount
        vm.expectRevert(EquityStreamVault.BadSchedule.selector);
        vault.list(address(equity), 1, uint64(block.timestamp), uint64(block.timestamp + 1), 0); // zero price
        vm.stopPrank();
    }

    function test_cancelReturnsTokens() public {
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 30 days), 5_000e6);
        uint256 before = equity.balanceOf(alice);
        vm.prank(alice);
        vault.cancel(id);
        assertEq(equity.balanceOf(alice), before + 100e18);
        (,,, uint128 amount,,,,) = vault.streams(id);
        assertEq(amount, 0); // deleted
    }

    function test_onlySellerCanCancel() public {
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 30 days), 5_000e6);
        vm.prank(bob);
        vm.expectRevert(EquityStreamVault.NotSeller.selector);
        vault.cancel(id);
    }

    function test_buyPaysSellerDirectly() public {
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 30 days), 5_000e6);
        uint256 sellerBefore = usdc.balanceOf(alice);
        uint256 buyerBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.buy(id);
        assertEq(usdc.balanceOf(alice), sellerBefore + 5_000e6);
        assertEq(usdc.balanceOf(bob), buyerBefore - 5_000e6);
        (,, address buyer,,,,, uint128 ask) = vault.streams(id);
        assertEq(buyer, bob);
        assertEq(ask, 0);
    }

    function test_cannotBuyTwice() public {
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 30 days), 5_000e6);
        vm.prank(bob);
        vault.buy(id);
        vm.prank(address(0xCA401));
        vm.expectRevert(EquityStreamVault.NotForSale.selector);
        vault.buy(id);
    }

    function test_cannotCancelAfterSold() public {
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 30 days), 5_000e6);
        vm.prank(bob);
        vault.buy(id);
        vm.prank(alice);
        vm.expectRevert(EquityStreamVault.AlreadySold.selector);
        vault.cancel(id);
    }

    function test_vestingIsLinear() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = start + 100 days;
        uint256 id = _list(100e18, start, end, 5_000e6);
        assertEq(vault.vestedAmount(id), 0);
        vm.warp(start + 25 days);
        assertEq(vault.vestedAmount(id), 25e18);
        vm.warp(start + 100 days);
        assertEq(vault.vestedAmount(id), 100e18);
        vm.warp(start + 500 days);
        assertEq(vault.vestedAmount(id), 100e18); // capped
    }

    function test_claimableZeroBeforeSale() public {
        uint64 start = uint64(block.timestamp);
        uint256 id = _list(100e18, start, start + 10 days, 5_000e6);
        vm.warp(start + 5 days);
        assertEq(vault.claimable(id), 0); // nobody owns it yet
    }

    function test_claimAndReclaimOverTime() public {
        uint64 start = uint64(block.timestamp);
        uint256 id = _list(100e18, start, start + 100 days, 5_000e6);
        vm.prank(bob);
        vault.buy(id);

        vm.warp(start + 25 days);
        vm.prank(bob);
        assertEq(vault.claim(id), 25e18);
        assertEq(equity.balanceOf(bob), 25e18);
        assertEq(vault.claimable(id), 0);

        vm.warp(start + 60 days);
        vm.prank(bob);
        assertEq(vault.claim(id), 35e18);
        assertEq(equity.balanceOf(bob), 60e18);

        vm.warp(start + 500 days);
        vm.prank(bob);
        assertEq(vault.claim(id), 40e18);
        assertEq(equity.balanceOf(bob), 100e18);
    }

    function test_onlyBuyerCanClaim() public {
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 10 days), 5_000e6);
        vm.prank(bob);
        vault.buy(id);
        vm.warp(block.timestamp + 5 days);
        vm.prank(alice);
        vm.expectRevert(EquityStreamVault.NotBuyer.selector);
        vault.claim(id);
    }

    function test_nothingToClaimReverts() public {
        uint256 id = _list(100e18, uint64(block.timestamp), uint64(block.timestamp + 10 days), 5_000e6);
        vm.prank(bob);
        vault.buy(id);
        vm.prank(bob);
        vm.expectRevert(EquityStreamVault.NothingToClaim.selector);
        vault.claim(id); // no time has passed
    }

    function test_pastVestStartIsImmediatelyPartlyClaimable() public {
        vm.warp(365 days);
        uint64 start = uint64(block.timestamp - 50 days);
        uint256 id = _list(100e18, start, start + 100 days, 5_000e6);
        vm.prank(bob);
        vault.buy(id);
        vm.prank(bob);
        assertEq(vault.claim(id), 50e18);
    }

    /// Across random schedules, purchase timing, and claim timing, claims never exceed the locked
    /// amount, and the vault's token balance always covers what's left unclaimed.
    function testFuzz_neverOverclaims(uint64 duration, uint64 buyDelay, uint64 claim1Delay, uint64 claim2Delay) public {
        duration = uint64(bound(duration, 1, 3650 days));
        uint64 start = uint64(block.timestamp);
        uint64 end = start + duration;
        uint128 amount = 100e18;
        uint256 id = _list(amount, start, end, 5_000e6);

        vm.warp(start + bound(buyDelay, 0, duration * 2));
        vm.prank(bob);
        vault.buy(id);

        vm.warp(block.timestamp + bound(claim1Delay, 0, duration * 2));
        vm.prank(bob);
        try vault.claim(id) {} catch {}

        vm.warp(block.timestamp + bound(claim2Delay, 0, duration * 2));
        vm.prank(bob);
        try vault.claim(id) {} catch {}

        assertLe(equity.balanceOf(bob), amount);
        assertEq(equity.balanceOf(bob) + equity.balanceOf(address(vault)), amount);
        if (block.timestamp >= end) {
            vm.prank(bob);
            try vault.claim(id) {} catch {}
            assertEq(equity.balanceOf(bob), amount);
        }
    }
}
