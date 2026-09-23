// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IComputeIndex {
    function hasSettlement(uint256 marketId) external view returns (bool);
    function settlementPrice(uint256 marketId) external view returns (uint256);
}

/// @title ComputeExchange
/// @notice Onchain central limit order book for cash-settled compute contracts
/// (e.g. "1 H100-hour, us-east, week N"). Each contract pays `settlePrice` USDC to the
/// long and `maxPrice - settlePrice` to the short, so both sides are fully collateralised:
/// no leverage, no liquidations. Matching is price-time priority with maker-price fills.
contract ComputeExchange {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Market {
        bytes32 sku;
        uint64 closeTime; // trading stops
        uint64 settleTime; // index settlement may be posted after this
        uint32 maxTick; // price ceiling in ticks (<= 1024)
        uint128 tickSize; // USDC (6dp) per tick, per contract
        bool settled;
        uint128 settlePrice; // USDC (6dp) per contract, in [0, maxTick*tickSize]
        uint128 maxMarketCollateral; // total USDC this market may lock; 0 = uncapped
        uint128 maxUserCollateral; // USDC any single user may lock in this market; 0 = uncapped
    }

    struct Order {
        address owner;
        uint64 marketId;
        uint32 tick;
        bool isBid;
        uint64 qty; // remaining, 0 = filled/cancelled
        uint64 next;
    }

    struct Level {
        uint64 head;
        uint64 tail;
        uint128 qty; // live quantity at this price
    }

    struct Side {
        uint256[4] bitmap; // 1024 price ticks
        mapping(uint32 => Level) levels;
    }

    struct Book {
        Side bids;
        Side asks;
    }

    /// cash: USDC posted plus net trade proceeds. pos: signed contracts (long > 0).
    struct Acct {
        int256 cash;
        int256 pos;
        uint256 bidQty;
        uint256 bidNotional;
        uint256 askQty;
        uint256 askNotional;
    }

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC20Min public immutable usdc;
    IComputeIndex public immutable index;
    address public owner;
    bool public paused; // blocks new orders only; cancel, release, settle, claim, withdraw always work

    uint256 public marketCount;
    uint64 public orderCount;
    uint256 public constant MAX_SWEEP_ORDERS = 60; // resting orders touched per placeOrder call, bounds worst-case gas

    mapping(uint256 => Market) public markets;
    mapping(uint256 => Book) internal books;
    mapping(uint64 => Order) public orders;
    mapping(address => uint256) public free;
    mapping(uint256 => mapping(address => Acct)) public accts;
    mapping(uint256 => uint256) public totalLocked; // USDC currently committed as collateral, per market
    mapping(uint256 => mapping(address => uint256)) public userLocked; // USDC committed, per market per user

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event MarketCreated(uint256 indexed marketId, bytes32 indexed sku, uint64 closeTime, uint64 settleTime, uint32 maxTick, uint128 tickSize);
    event OrderPlaced(uint256 indexed marketId, uint64 indexed orderId, address indexed owner, bool isBid, uint32 tick, uint64 qty);
    event OrderCancelled(uint256 indexed marketId, uint64 indexed orderId);
    event Trade(uint256 indexed marketId, uint64 indexed makerOrderId, address maker, address taker, bool takerBuys, uint32 tick, uint64 qty);
    event Settled(uint256 indexed marketId, uint256 price);
    event Claimed(uint256 indexed marketId, address indexed user, uint256 payout);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotOwner();
    error BadParams();
    error TradingClosed();
    error NotSettled();
    error InsufficientCollateral();
    error NotYourOrder();
    error IsPaused();
    error MarketCapExceeded();
    error UserCapExceeded();

    constructor(address _usdc, address _index) {
        usdc = IERC20Min(_usdc);
        index = IComputeIndex(_index);
        owner = msg.sender;
    }

    function setPaused(bool p) external {
        if (msg.sender != owner) revert NotOwner();
        paused = p;
    }

    /*//////////////////////////////////////////////////////////////
                               MARKETS
    //////////////////////////////////////////////////////////////*/

    /// @param maxMarketCollateral total USDC this market may ever lock as collateral; 0 = uncapped
    /// @param maxUserCollateral USDC any single user may lock in this market; 0 = uncapped
    function createMarket(
        bytes32 sku,
        uint64 closeTime,
        uint64 settleTime,
        uint32 maxTick,
        uint128 tickSize,
        uint128 maxMarketCollateral,
        uint128 maxUserCollateral
    ) external returns (uint256 id) {
        if (msg.sender != owner) revert NotOwner();
        if (maxTick < 2 || maxTick > 1024 || tickSize == 0 || settleTime < closeTime || closeTime <= block.timestamp) {
            revert BadParams();
        }
        id = ++marketCount;
        markets[id] = Market(sku, closeTime, settleTime, maxTick, tickSize, false, 0, maxMarketCollateral, maxUserCollateral);
        emit MarketCreated(id, sku, closeTime, settleTime, maxTick, tickSize);
    }

    /*//////////////////////////////////////////////////////////////
                              COLLATERAL
    //////////////////////////////////////////////////////////////*/

    function deposit(uint256 amount) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer");
        free[msg.sender] += amount;
    }

    function withdraw(uint256 amount) external {
        free[msg.sender] -= amount;
        require(usdc.transfer(msg.sender, amount), "transfer");
    }

    /// @notice Move collateral that is not needed to back positions/orders in a market back to free balance.
    function release(uint256 marketId, uint256 amount) external {
        Market storage m = markets[marketId];
        Acct storage a = accts[marketId][msg.sender];
        int256 headroom = _minEquity(a, uint256(m.maxTick) * m.tickSize);
        if (headroom < 0 || amount > uint256(headroom)) revert InsufficientCollateral();
        a.cash -= int256(amount);
        totalLocked[marketId] -= amount; // conserved market-wide: fills only move cash between users already counted here
        uint256 userLoc = userLocked[marketId][msg.sender];
        // per-user cash also grows from trading profit, which was never "locked" capital, so saturate instead of underflowing
        userLocked[marketId][msg.sender] = amount < userLoc ? userLoc - amount : 0;
        free[msg.sender] += amount;
    }

    /// @dev Worst-case equity across settle price in [0, max] and every combination of resting orders filling.
    function _minEquity(Acct storage a, uint256 maxPrice) internal view returns (int256 minEq) {
        int256 mp = int256(maxPrice);
        int256 bn = int256(a.bidNotional);
        int256 an = int256(a.askNotional);
        int256 bq = int256(a.bidQty);
        int256 aq = int256(a.askQty);
        int256 c = a.cash;
        int256 p = a.pos;

        minEq = _eq(c, p, mp);
        int256 s = _eq(c - bn, p + bq, mp);
        if (s < minEq) minEq = s;
        s = _eq(c + an, p - aq, mp);
        if (s < minEq) minEq = s;
        s = _eq(c - bn + an, p + bq - aq, mp);
        if (s < minEq) minEq = s;
    }

    function _eq(int256 cash, int256 pos, int256 maxPrice) private pure returns (int256) {
        return pos < 0 ? cash + pos * maxPrice : cash;
    }

    function _topUp(uint256 marketId, address user, uint256 maxPrice) internal {
        Acct storage a = accts[marketId][user];
        int256 minEq = _minEquity(a, maxPrice);
        if (minEq < 0) {
            uint256 need = uint256(-minEq);
            Market storage m = markets[marketId];
            if (m.maxUserCollateral > 0 && userLocked[marketId][user] + need > m.maxUserCollateral) revert UserCapExceeded();
            if (m.maxMarketCollateral > 0 && totalLocked[marketId] + need > m.maxMarketCollateral) revert MarketCapExceeded();
            if (free[user] < need) revert InsufficientCollateral();
            free[user] -= need;
            a.cash += int256(need);
            totalLocked[marketId] += need;
            userLocked[marketId][user] += need;
        }
    }

    /*//////////////////////////////////////////////////////////////
                                TRADING
    //////////////////////////////////////////////////////////////*/

    /// @notice Place a limit order. Crosses the book at maker prices, rests any remainder unless `ioc`.
    /// Required collateral is pulled from the caller's free balance automatically.
    /// @return orderId id of the resting remainder (0 if none rested)
    /// @return filled quantity matched immediately
    function placeOrder(uint256 marketId, bool isBid, uint32 tick, uint64 qty, bool ioc)
        external
        returns (uint64 orderId, uint64 filled)
    {
        if (paused) revert IsPaused();
        Market storage m = markets[marketId];
        if (m.tickSize == 0) revert BadParams();
        if (block.timestamp >= m.closeTime) revert TradingClosed();
        if (tick == 0 || tick >= m.maxTick || qty == 0) revert BadParams();

        filled = _match(marketId, isBid, tick, qty, m.tickSize);
        if (filled < qty && !ioc) {
            orderId = _rest(marketId, isBid, tick, qty - filled, m.tickSize);
        }
        _topUp(marketId, msg.sender, uint256(m.maxTick) * m.tickSize);
    }

    function _match(uint256 marketId, bool isBid, uint32 tick, uint64 qty, uint128 tickSize)
        internal
        returns (uint64 filled)
    {
        Side storage opp = isBid ? books[marketId].asks : books[marketId].bids;
        Acct storage ta = accts[marketId][msg.sender];
        uint256 sweeps;

        while (filled < qty && sweeps < MAX_SWEEP_ORDERS) {
            (bool ok, uint32 best) = isBid ? _lowest(opp) : _highest(opp);
            if (!ok || (isBid ? best > tick : best < tick)) break;
            uint256 used;
            (filled, used) = _sweepLevel(marketId, opp, best, ta, isBid, qty, filled, tickSize, MAX_SWEEP_ORDERS - sweeps);
            sweeps += used;
            if (opp.levels[best].qty == 0) _clearBit(opp, best);
        }
    }

    /// @dev Visits at most `budget` resting orders (fills, self-trade cancels, and empty-slot cleanup
    /// all count) so a single call's gas cost is bounded regardless of book state.
    function _sweepLevel(
        uint256 marketId,
        Side storage opp,
        uint32 best,
        Acct storage ta,
        bool takerBuys,
        uint64 qty,
        uint64 filled,
        uint128 tickSize,
        uint256 budget
    ) internal returns (uint64, uint256) {
        Level storage lvl = opp.levels[best];
        uint64 id = lvl.head;
        uint256 used;
        while (id != 0 && filled < qty && used < budget) {
            used++;
            Order storage o = orders[id];
            if (o.qty == 0) {
                id = _pop(lvl);
                continue;
            }
            if (o.owner == msg.sender) {
                _cancelInternal(marketId, id, o, opp, lvl, tickSize);
                id = lvl.head;
                continue;
            }
            uint64 want = qty - filled;
            uint64 fill = want < o.qty ? want : o.qty;
            _applyFill(marketId, o, ta, takerBuys, fill, tickSize);
            emit Trade(marketId, id, o.owner, msg.sender, takerBuys, best, fill);
            filled += fill;
            if (o.qty == 0) id = _pop(lvl);
        }
        return (filled, used);
    }

    function _rest(uint256 marketId, bool isBid, uint32 tick, uint64 remaining, uint128 tickSize)
        internal
        returns (uint64 orderId)
    {
        orderId = ++orderCount;
        orders[orderId] = Order(msg.sender, uint64(marketId), tick, isBid, remaining, 0);
        Side storage mine = isBid ? books[marketId].bids : books[marketId].asks;
        Level storage l = mine.levels[tick];
        if (l.head == 0) {
            l.head = orderId;
        } else {
            orders[l.tail].next = orderId;
        }
        l.tail = orderId;
        l.qty += remaining;
        _setBit(mine, tick);

        Acct storage ta = accts[marketId][msg.sender];
        uint256 notional = uint256(remaining) * tick * tickSize;
        if (isBid) {
            ta.bidQty += remaining;
            ta.bidNotional += notional;
        } else {
            ta.askQty += remaining;
            ta.askNotional += notional;
        }
        emit OrderPlaced(marketId, orderId, msg.sender, isBid, tick, remaining);
    }

    function cancelOrder(uint64 orderId) external {
        Order storage o = orders[orderId];
        if (o.owner != msg.sender) revert NotYourOrder();
        if (o.qty == 0) revert BadParams();
        uint256 marketId = o.marketId;
        Side storage side = o.isBid ? books[marketId].bids : books[marketId].asks;
        _cancelInternal(marketId, orderId, o, side, side.levels[o.tick], markets[marketId].tickSize);
    }

    function _cancelInternal(
        uint256 marketId,
        uint64 orderId,
        Order storage o,
        Side storage side,
        Level storage lvl,
        uint128 tickSize
    ) internal {
        Acct storage a = accts[marketId][o.owner];
        uint256 notional = uint256(o.qty) * o.tick * tickSize;
        if (o.isBid) {
            a.bidQty -= o.qty;
            a.bidNotional -= notional;
        } else {
            a.askQty -= o.qty;
            a.askNotional -= notional;
        }
        lvl.qty -= o.qty;
        o.qty = 0;
        if (lvl.qty == 0) _clearBit(side, o.tick);
        if (lvl.head == orderId) _pop(lvl);
        emit OrderCancelled(marketId, orderId);
    }

    function _applyFill(uint256 marketId, Order storage maker, Acct storage ta, bool takerBuys, uint64 fill, uint128 tickSize)
        internal
    {
        uint256 price = uint256(maker.tick) * tickSize;
        int256 value = int256(uint256(fill) * price);
        Acct storage ma = accts[marketId][maker.owner];

        if (takerBuys) {
            ma.askQty -= fill;
            ma.askNotional -= uint256(value);
            ma.pos -= int256(uint256(fill));
            ma.cash += value;
            ta.pos += int256(uint256(fill));
            ta.cash -= value;
        } else {
            ma.bidQty -= fill;
            ma.bidNotional -= uint256(value);
            ma.pos += int256(uint256(fill));
            ma.cash -= value;
            ta.pos -= int256(uint256(fill));
            ta.cash += value;
        }
        maker.qty -= fill;
        (takerBuys ? books[marketId].asks : books[marketId].bids).levels[maker.tick].qty -= fill;
    }

    function _pop(Level storage lvl) internal returns (uint64 newHead) {
        newHead = orders[lvl.head].next;
        lvl.head = newHead;
        if (newHead == 0) lvl.tail = 0;
    }

    /*//////////////////////////////////////////////////////////////
                              SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    function settle(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (m.settled || block.timestamp < m.settleTime || !index.hasSettlement(marketId)) revert NotSettled();
        uint256 maxPrice = uint256(m.maxTick) * m.tickSize;
        uint256 p = index.settlementPrice(marketId);
        if (p > maxPrice) p = maxPrice;
        m.settled = true;
        m.settlePrice = uint128(p);
        emit Settled(marketId, p);
    }

    function claim(uint256 marketId) external returns (uint256 payout) {
        Market storage m = markets[marketId];
        if (!m.settled) revert NotSettled();
        Acct storage a = accts[marketId][msg.sender];
        int256 value = a.cash + a.pos * int256(uint256(m.settlePrice));
        require(value >= 0, "insolvent");
        payout = uint256(value);
        delete accts[marketId][msg.sender];
        free[msg.sender] += payout;
        emit Claimed(marketId, msg.sender, payout);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function bestBid(uint256 marketId) external view returns (bool ok, uint32 tick) {
        return _highest(books[marketId].bids);
    }

    function bestAsk(uint256 marketId) external view returns (bool ok, uint32 tick) {
        return _lowest(books[marketId].asks);
    }

    /// @notice Top `n` price levels on one side, best first.
    function getDepth(uint256 marketId, bool isBid, uint256 n)
        external
        view
        returns (uint32[] memory ticks, uint128[] memory qtys)
    {
        Side storage s = isBid ? books[marketId].bids : books[marketId].asks;
        uint32[] memory t = new uint32[](n);
        uint128[] memory q = new uint128[](n);
        uint256 count;
        (bool ok, uint32 cur) = isBid ? _highest(s) : _lowest(s);
        while (ok && count < n) {
            t[count] = cur;
            q[count] = s.levels[cur].qty;
            count++;
            (ok, cur) = isBid ? _below(s, cur) : _above(s, cur);
        }
        assembly {
            mstore(t, count)
            mstore(q, count)
        }
        return (t, q);
    }

    /// @notice Simulate a market order against the resting book. Used by the router to compare venues.
    /// @return filled quantity available, cost total USDC (6dp) to pay (buy) or receive (sell)
    function quote(uint256 marketId, bool isBuy, uint64 qty) external view returns (uint64 filled, uint256 cost) {
        Side storage s = isBuy ? books[marketId].asks : books[marketId].bids;
        uint128 tickSize = markets[marketId].tickSize;
        (bool ok, uint32 cur) = isBuy ? _lowest(s) : _highest(s);
        while (ok && filled < qty) {
            uint128 avail = s.levels[cur].qty;
            uint64 take = uint64(avail < qty - filled ? avail : qty - filled);
            filled += take;
            cost += uint256(take) * cur * tickSize;
            (ok, cur) = isBuy ? _above(s, cur) : _below(s, cur);
        }
    }

    function collateralHeadroom(uint256 marketId, address user) external view returns (int256) {
        Market storage m = markets[marketId];
        return _minEquity(accts[marketId][user], uint256(m.maxTick) * m.tickSize);
    }

    /*//////////////////////////////////////////////////////////////
                              BITMAP HELPERS
    //////////////////////////////////////////////////////////////*/

    function _setBit(Side storage s, uint32 tick) private {
        s.bitmap[tick >> 8] |= (uint256(1) << (tick & 255));
    }

    function _clearBit(Side storage s, uint32 tick) private {
        s.bitmap[tick >> 8] &= ~(uint256(1) << (tick & 255));
    }

    function _highest(Side storage s) private view returns (bool, uint32) {
        for (uint256 w = 4; w > 0; w--) {
            uint256 word = s.bitmap[w - 1];
            if (word != 0) return (true, uint32((w - 1) * 256 + _msb(word)));
        }
        return (false, 0);
    }

    function _lowest(Side storage s) private view returns (bool, uint32) {
        for (uint256 w = 0; w < 4; w++) {
            uint256 word = s.bitmap[w];
            if (word != 0) return (true, uint32(w * 256 + _lsb(word)));
        }
        return (false, 0);
    }

    function _below(Side storage s, uint32 tick) private view returns (bool, uint32) {
        uint256 w = tick >> 8;
        uint256 bit = tick & 255;
        uint256 word = bit == 0 ? 0 : s.bitmap[w] & ((uint256(1) << bit) - 1);
        while (true) {
            if (word != 0) return (true, uint32(w * 256 + _msb(word)));
            if (w == 0) return (false, 0);
            w--;
            word = s.bitmap[w];
        }
        return (false, 0);
    }

    function _above(Side storage s, uint32 tick) private view returns (bool, uint32) {
        uint256 w = tick >> 8;
        uint256 bit = tick & 255;
        uint256 word = bit == 255 ? 0 : s.bitmap[w] & ~((uint256(1) << (bit + 1)) - 1);
        while (true) {
            if (word != 0) return (true, uint32(w * 256 + _lsb(word)));
            if (w == 3) return (false, 0);
            w++;
            word = s.bitmap[w];
        }
        return (false, 0);
    }

    function _lsb(uint256 x) private pure returns (uint256) {
        return _msb(x & (~x + 1));
    }

    function _msb(uint256 x) private pure returns (uint256 r) {
        if (x >= 1 << 128) { x >>= 128; r += 128; }
        if (x >= 1 << 64) { x >>= 64; r += 64; }
        if (x >= 1 << 32) { x >>= 32; r += 32; }
        if (x >= 1 << 16) { x >>= 16; r += 16; }
        if (x >= 1 << 8) { x >>= 8; r += 8; }
        if (x >= 1 << 4) { x >>= 4; r += 4; }
        if (x >= 1 << 2) { x >>= 2; r += 2; }
        if (x >= 1 << 1) { r += 1; }
    }
}
