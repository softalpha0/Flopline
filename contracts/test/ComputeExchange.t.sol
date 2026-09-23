// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/ComputeExchange.sol";
import "../src/ComputeIndex.sol";
import "../src/MockUSDC.sol";

contract ComputeExchangeTest is Test {
    MockUSDC usdc;
    ComputeIndex idx;
    ComputeExchange ex;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    uint256 constant TICK = 10_000; // $0.01
    uint32 constant MAXTICK = 1000; // $10.00 ceiling
    uint256 constant M = 1;
    uint256 closeTime;
    uint256 settleTime;

    function setUp() public {
        usdc = new MockUSDC();
        idx = new ComputeIndex();
        ex = new ComputeExchange(address(usdc), address(idx));
        closeTime = block.timestamp + 7 days;
        settleTime = closeTime + 7 days;
        ex.createMarket("H100-USEAST-W42", uint64(closeTime), uint64(settleTime), MAXTICK, uint128(TICK), 0, 0);
        _fund(alice, 10_000e6);
        _fund(bob, 10_000e6);
        _fund(carol, 10_000e6);
    }

    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(amt);
        vm.stopPrank();
    }

    function _place(address who, bool bid, uint32 tick, uint64 qty) internal returns (uint64 id, uint64 filled) {
        vm.prank(who);
        return ex.placeOrder(M, bid, tick, qty, false);
    }

    function _acct(address who) internal view returns (int256 cash, int256 pos) {
        (cash, pos,,,,) = ex.accts(M, who);
    }

    function test_restingOrderLocksWorstCaseCollateral() public {
        // Ask 100 @ $2.50: short worst case = (10.00 - 2.50) * 100 = $750
        _place(alice, false, 250, 100);
        assertEq(ex.free(alice), 10_000e6 - 750e6);
        // Bid 100 @ $2.00 locks $200
        _place(bob, true, 200, 100);
        assertEq(ex.free(bob), 10_000e6 - 200e6);
    }

    function test_matchAtMakerPrice() public {
        _place(alice, false, 250, 100);
        (uint64 id, uint64 filled) = _place(bob, true, 260, 40);
        assertEq(filled, 40);
        assertEq(id, 0);

        (int256 bc, int256 bp) = _acct(bob);
        assertEq(bp, 40);
        // filled at maker price 2.50 (not 2.60): $100 owed, topped up from free balance
        assertEq(bc, 0);
        assertEq(ex.free(bob), 10_000e6 - 40 * 250 * TICK);

        (int256 ac, int256 ap) = _acct(alice);
        assertEq(ap, -40);
        assertEq(ac, int256(750e6) + int256(40 * 250 * TICK)); // reserve + proceeds
    }

    function test_priceTimePriority() public {
        (uint64 a1,) = _place(alice, false, 250, 10);
        (uint64 c1,) = _place(carol, false, 250, 10);
        (uint64 a2,) = _place(alice, false, 240, 10); // better price, later
        _place(bob, true, 250, 15);

        (,,,, uint64 q1,) = ex.orders(a1);
        (,,,, uint64 q2,) = ex.orders(c1);
        (,,,, uint64 q3,) = ex.orders(a2);
        assertEq(q3, 0, "best price fills first");
        assertEq(q1, 5, "then earliest at level");
        assertEq(q2, 10, "later order untouched");
    }

    function test_walksMultipleLevels() public {
        _place(alice, false, 240, 10);
        _place(alice, false, 250, 10);
        _place(carol, false, 260, 10);
        (uint64 id, uint64 filled) = _place(bob, true, 260, 25);
        assertEq(filled, 25);
        assertEq(id, 0);
        (, int256 pos) = _acct(bob);
        assertEq(pos, 25);
        (uint64 f, uint256 cost) = ex.quote(M, true, 100);
        assertEq(f, 5);
        assertEq(cost, 5 * 260 * TICK);
    }

    function test_cancelReleasesCollateral() public {
        (uint64 id,) = _place(alice, false, 250, 100);
        assertEq(ex.free(alice), 10_000e6 - 750e6);
        vm.prank(alice);
        ex.cancelOrder(id);
        assertEq(ex.collateralHeadroom(M, alice), 0 + int256(750e6));
        vm.prank(alice);
        ex.release(M, 750e6);
        assertEq(ex.free(alice), 10_000e6);
        (bool ok,) = ex.bestAsk(M);
        assertFalse(ok);
    }

    function test_cannotCancelOthersOrder() public {
        (uint64 id,) = _place(alice, false, 250, 100);
        vm.prank(bob);
        vm.expectRevert(ComputeExchange.NotYourOrder.selector);
        ex.cancelOrder(id);
    }

    function test_revertsWithoutCollateral() public {
        vm.prank(alice);
        ex.withdraw(10_000e6);
        vm.prank(alice);
        vm.expectRevert(ComputeExchange.InsufficientCollateral.selector);
        ex.placeOrder(M, true, 250, 10, false);
    }

    function test_closingLongFreesCollateral() public {
        _place(alice, false, 250, 100);
        _place(bob, true, 250, 100); // bob long 100, paid $250
        assertEq(ex.free(bob), 10_000e6 - 250e6);
        // bob sells 100 into carol's $3.00 bid -> $50 profit, position flat
        _place(carol, true, 300, 100);
        _place(bob, false, 300, 100);
        (int256 cash, int256 pos) = _acct(bob);
        assertEq(pos, 0);
        assertEq(cash, 300e6);
        vm.prank(bob);
        ex.release(M, 300e6);
        assertEq(ex.free(bob), 10_000e6 + 50e6);
    }

    function test_selfTradePreventionCancelsMaker() public {
        (uint64 id,) = _place(alice, false, 250, 10);
        (uint64 rest, uint64 filled) = _place(alice, true, 250, 10);
        assertEq(filled, 0);
        assertGt(rest, 0);
        (,,,, uint64 q,) = ex.orders(id);
        assertEq(q, 0);
    }

    function test_settlementPaysLongAndShort() public {
        _place(alice, false, 250, 100); // alice short
        _place(bob, true, 250, 100); // bob long
        uint256 before = ex.free(alice) + ex.free(bob);

        vm.warp(settleTime);
        idx.reportSettlement(M, 3_00e4); // $3.00
        ex.settle(M);

        vm.prank(alice);
        uint256 pa = ex.claim(M);
        vm.prank(bob);
        uint256 pb = ex.claim(M);

        // total collateral 100 * $10 = $1000 split by settlement: long 300, short 700
        assertEq(pb, 100 * 300 * TICK);
        assertEq(pa, 100 * (1000 - 300) * TICK);
        assertEq(ex.free(alice) + ex.free(bob), before + 1000e6 - 0);
    }

    function test_settlementClampedToMax() public {
        _place(alice, false, 250, 10);
        _place(bob, true, 250, 10);
        vm.warp(settleTime);
        idx.reportSettlement(M, 999e6);
        ex.settle(M);
        vm.prank(alice);
        assertEq(ex.claim(M), 0);
        vm.prank(bob);
        assertEq(ex.claim(M), 10 * 1000 * TICK);
    }

    function test_cannotTradeAfterClose() public {
        vm.warp(closeTime);
        vm.prank(alice);
        vm.expectRevert(ComputeExchange.TradingClosed.selector);
        ex.placeOrder(M, true, 250, 10, false);
    }

    function test_cannotSettleEarly() public {
        idx.reportSettlement(M, 300e4);
        vm.expectRevert(ComputeExchange.NotSettled.selector);
        ex.settle(M);
    }

    function test_depthView() public {
        _place(alice, false, 260, 5);
        _place(alice, false, 250, 7);
        _place(bob, true, 240, 3);
        _place(bob, true, 230, 9);
        (uint32[] memory t, uint128[] memory q) = ex.getDepth(M, false, 5);
        assertEq(t.length, 2);
        assertEq(t[0], 250);
        assertEq(q[0], 7);
        assertEq(t[1], 260);
        (t, q) = ex.getDepth(M, true, 5);
        assertEq(t[0], 240);
        assertEq(t[1], 230);
        assertEq(q[1], 9);
    }

    /// Random order flow must never make the exchange insolvent: after settling
    /// at any price, sum of payouts equals sum of all collateral that entered.
    function testFuzz_solvency(uint256 seed, uint256 settle) public {
        address[3] memory who = [alice, bob, carol];
        uint256 total = 30_000e6;
        for (uint256 i = 0; i < 40; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address u = who[seed % 3];
            bool bid = (seed >> 8) % 2 == 0;
            uint32 tick = uint32(200 + (seed >> 16) % 100);
            uint64 qty = uint64(1 + (seed >> 32) % 50);
            if ((seed >> 48) % 5 == 0) {
                // occasionally cancel the last order of this user if live
                uint64 oid = uint64(1 + (seed >> 56) % (ex.orderCount() + 1));
                (address ow,,,, uint64 q,) = ex.orders(oid);
                if (ow == u && q > 0) {
                    vm.prank(u);
                    ex.cancelOrder(oid);
                }
                continue;
            }
            vm.prank(u);
            try ex.placeOrder(M, bid, tick, qty, false) {} catch {}
        }
        vm.warp(settleTime);
        idx.reportSettlement(M, bound(settle, 0, 1200) * TICK);
        ex.settle(M);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(who[i]);
            ex.claim(M);
        }
        assertEq(ex.free(alice) + ex.free(bob) + ex.free(carol), total);
        assertEq(usdc.balanceOf(address(ex)), total);
    }
}
