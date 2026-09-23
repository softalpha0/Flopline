// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Basic {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IExchangeMarkets {
    function markets(uint256 id)
        external
        view
        returns (bytes32 sku, uint64 closeTime, uint64 settleTime, uint32 maxTick, uint128 tickSize, bool settled, uint128 settlePrice);
}

/// @notice ERC-20 for one side of a compute contract. Minted and burned only by the PairMinter.
contract PositionToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable minter;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "minter");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == minter, "minter");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title PairMinter
/// @notice Splits USDC into a long and a short token for a ComputeExchange market ("complete set"), so either side
/// can trade on any spot venue (for example Kuru). One pair is fully collateralised at maxPrice USDC per GPU-hour.
/// After the market settles at price S, a long token redeems for S and a short token for (maxPrice - S).
/// Token amounts use 6 decimals: 1e6 units = 1 GPU-hour. Payouts round down.
contract PairMinter {
    IERC20Basic public immutable usdc;
    IExchangeMarkets public immutable exchange;

    struct Pair {
        PositionToken long;
        PositionToken short;
    }

    mapping(uint256 => Pair) public pairs;

    event PairCreated(uint256 indexed marketId, address long, address short);
    event Minted(uint256 indexed marketId, address indexed user, uint256 amount);
    event Merged(uint256 indexed marketId, address indexed user, uint256 amount);
    event Redeemed(uint256 indexed marketId, address indexed user, bool isLong, uint256 amount, uint256 payout);

    error MarketClosed();
    error NotSettled();
    error UnknownMarket();

    constructor(address _usdc, address _exchange) {
        usdc = IERC20Basic(_usdc);
        exchange = IExchangeMarkets(_exchange);
    }

    function _market(uint256 id) internal view returns (uint64 closeTime, uint256 maxPrice, bool settled, uint256 settlePrice) {
        (, uint64 c,, uint32 maxTick, uint128 tickSize, bool s, uint128 sp) = exchange.markets(id);
        if (tickSize == 0) revert UnknownMarket();
        return (c, uint256(maxTick) * tickSize, s, sp);
    }

    /// @notice Deposit `amount` * maxPrice / 1e6 USDC and receive `amount` long and short tokens.
    function mint(uint256 marketId, uint256 amount) external {
        (uint64 closeTime, uint256 maxPrice, bool settled,) = _market(marketId);
        if (settled || block.timestamp >= closeTime) revert MarketClosed();

        Pair storage p = pairs[marketId];
        if (address(p.long) == address(0)) {
            string memory id = _str(marketId);
            p.long = new PositionToken(string.concat("Flopline Long #", id), string.concat("fL", id));
            p.short = new PositionToken(string.concat("Flopline Short #", id), string.concat("fS", id));
            emit PairCreated(marketId, address(p.long), address(p.short));
        }

        uint256 cost = _mulUp(amount, maxPrice, 1e6);
        require(usdc.transferFrom(msg.sender, address(this), cost), "transfer");
        p.long.mint(msg.sender, amount);
        p.short.mint(msg.sender, amount);
        emit Minted(marketId, msg.sender, amount);
    }

    /// @notice Burn equal long and short tokens for their full collateral, any time before settlement.
    function merge(uint256 marketId, uint256 amount) external {
        (, uint256 maxPrice, bool settled,) = _market(marketId);
        if (settled) revert MarketClosed();
        Pair storage p = pairs[marketId];
        p.long.burn(msg.sender, amount);
        p.short.burn(msg.sender, amount);
        require(usdc.transfer(msg.sender, amount * maxPrice / 1e6), "transfer");
        emit Merged(marketId, msg.sender, amount);
    }

    /// @notice After settlement, redeem one side at its settlement value.
    function redeem(uint256 marketId, bool isLong, uint256 amount) external returns (uint256 payout) {
        (, uint256 maxPrice, bool settled, uint256 settlePrice) = _market(marketId);
        if (!settled) revert NotSettled();
        Pair storage p = pairs[marketId];
        uint256 unit = isLong ? settlePrice : maxPrice - settlePrice;
        (isLong ? p.long : p.short).burn(msg.sender, amount);
        payout = amount * unit / 1e6;
        require(usdc.transfer(msg.sender, payout), "transfer");
        emit Redeemed(marketId, msg.sender, isLong, amount, payout);
    }

    function _mulUp(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return (a * b + d - 1) / d;
    }

    function _str(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
