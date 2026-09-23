// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/ComputeExchange.sol";
import "../src/ComputeIndex.sol";
import "../src/MockUSDC.sol";

/// Safety mechanisms added for a small-cap, unaudited beta: an emergency pause that never blocks
/// exits, per-market and per-user collateral caps enforced onchain, and a bounded matching loop so
/// no single transaction can run out of gas.
contract ComputeExchangeCapsTest is Test {
    MockUSDC usdc;
    ComputeIndex idx;
    ComputeExchange ex;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 constant TICK = 10_000;
    uint256 closeTime;
    uint256 settleTime;

    function setUp() public {
        usdc = new MockUSDC();
        idx = new ComputeIndex();
        ex = new ComputeExchange(address(usdc), address(idx));
        closeTime = block.timestamp + 7 days;
        settleTime = closeTime + 7 days;
        for (address u = address(0x1000); uint160(u) < 0x1000 + 80; u = address(uint160(u) + 1)) {
            usdc.mint(u, 1_000_000e6);
            vm.startPrank(u);
            usdc.approve(address(ex), type(uint256).max);
            ex.deposit(1_000_000e6);
            vm.stopPrank();
        }
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(1_000_000e6);
        vm.stopPrank();
        vm.startPrank(bob);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(1_000_000e6);
        vm.stopPrank();
    }

    function _market(uint128 marketCap, uint128 userCap) internal returns (uint256) {
        return ex.createMarket("H100", uint64(closeTime), uint64(settleTime), 1000, uint128(TICK), marketCap, userCap);
    }

    /*//////////////////////////////////////////////////////////////
                                 PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_pauseBlocksNewOrders() public {
        uint256 m = _market(0, 0);
        vm.prank(alice);
        (uint64 id,) = ex.placeOrder(m, false, 250, 10, false);

        ex.setPaused(true);
        vm.prank(bob);
        vm.expectRevert(ComputeExchange.IsPaused.selector);
        ex.placeOrder(m, true, 250, 10, false);

        // exits still work while paused
        vm.prank(alice);
        ex.cancelOrder(id);
    }

    function test_onlyOwnerCanPause() public {
        vm.prank(alice);
        vm.expectRevert(ComputeExchange.NotOwner.selector);
        ex.setPaused(true);
    }

    function test_pauseDoesNotBlockSettlementOrClaim() public {
        uint256 m = _market(0, 0);
        vm.prank(alice);
        ex.placeOrder(m, false, 250, 10, false);
        vm.prank(bob);
        ex.placeOrder(m, true, 250, 10, false);

        ex.setPaused(true);
        vm.warp(settleTime);
        idx.reportSettlement(m, 250 * TICK);
        ex.settle(m); // settle is a market-owner-independent public call, unaffected by pause
        vm.prank(alice);
        ex.claim(m);
        vm.prank(bob);
        ex.claim(m);
    }

    /*//////////////////////////////////////////////////////////////
                                  CAPS
    //////////////////////////////////////////////////////////////*/

    function test_marketCapBlocksExceedingTopUp() public {
        // cap this market at $100 total locked; a $10.00-max-price contract needs $10 margin worst case per unit
        uint256 m = _market(100e6, 0);
        vm.prank(alice);
        ex.placeOrder(m, false, 500, 10, false); // asks 10 @ tick 500 -> locks 10 * (1000-500) * 0.01 = $50

        vm.prank(bob);
        vm.expectRevert(ComputeExchange.MarketCapExceeded.selector);
        ex.placeOrder(m, false, 500, 11, false); // would push total locked to $50 + $55 = $105 > $100 cap
    }

    function test_marketCapAllowsUpToLimit() public {
        uint256 m = _market(50e6, 0);
        vm.prank(alice);
        ex.placeOrder(m, false, 500, 10, false); // exactly $50, at the cap
        assertEq(ex.totalLocked(m), 50e6);
    }

    function test_userCapIsIndependentOfMarketCap() public {
        uint256 m = _market(1_000_000e6, 20e6); // market effectively uncapped, user capped at $20
        vm.prank(alice);
        ex.placeOrder(m, false, 500, 4, false); // $20 exactly
        vm.prank(alice);
        vm.expectRevert(ComputeExchange.UserCapExceeded.selector);
        ex.placeOrder(m, false, 500, 1, false); // one more unit would exceed alice's cap

        // bob is unaffected by alice's usage
        vm.prank(bob);
        ex.placeOrder(m, false, 500, 4, false);
    }

    function test_userCapResetsAfterRelease() public {
        uint256 m = _market(0, 20e6);
        vm.startPrank(alice);
        ex.placeOrder(m, false, 500, 4, false); // locks $20, at cap
        ex.cancelOrder(1);
        ex.release(m, 20e6);
        ex.placeOrder(m, false, 500, 4, false); // should succeed again now that it's released
        vm.stopPrank();
    }

    function test_tradingProfitDoesNotCountAgainstUserCap() public {
        // While a position is open, sale proceeds are still part of its worst-case collateral, so
        // headroom only exceeds the original locked margin once the position actually closes.
        // Exercise that: short, then buy back at a lower price to close flat at a profit, and
        // confirm releasing more than was ever "locked" saturates userLocked instead of underflowing.
        uint256 m = _market(0, 100e6); // comfortably covers carol's $70 worst-case margin below
        address carol = address(0x1005); // pre-funded in setUp
        vm.prank(alice);
        ex.placeOrder(m, false, 500, 10, false); // ask 10 @ $5.00, locks $50 (at alice's cap headroom)
        vm.prank(bob);
        ex.placeOrder(m, true, 500, 10, false); // fills alice's ask; alice now short 10

        vm.prank(carol);
        ex.placeOrder(m, false, 300, 10, false); // ask 10 @ $3.00
        vm.prank(alice);
        ex.placeOrder(m, true, 300, 10, false); // buys back at $3.00, closing alice flat at a $20 profit

        (int256 cash, int256 pos,,,,) = ex.accts(m, alice);
        assertEq(pos, 0);
        assertEq(cash, 70e6); // $50 margin + $50 sale - $30 buyback

        vm.prank(alice);
        ex.release(m, 70e6); // exceeds the $50 ever recorded in userLocked; must not underflow
        assertEq(ex.userLocked(m, alice), 0);
    }

    /*//////////////////////////////////////////////////////////////
                             BOUNDED SWEEP
    //////////////////////////////////////////////////////////////*/

    function test_matchIsBoundedPerCall() public {
        uint256 m = _market(0, 0);
        uint256 sweepCap = ex.MAX_SWEEP_ORDERS();
        uint256 restingOrders = sweepCap + 20;

        address u = address(0x1000);
        for (uint256 i = 0; i < restingOrders; i++) {
            vm.prank(u);
            ex.placeOrder(m, false, 500, 1, false); // many 1-unit asks at the same price
            u = address(uint160(u) + 1);
        }

        vm.prank(alice);
        (uint64 orderId, uint64 filled) = ex.placeOrder(m, true, 500, uint64(restingOrders), false);
        assertEq(filled, sweepCap, "fill capped at MAX_SWEEP_ORDERS in one call");
        assertGt(orderId, 0, "remainder rests instead of reverting or hanging");

        (,,,, uint64 restQty,) = ex.orders(orderId);
        assertEq(restQty, restingOrders - sweepCap);
    }
}
