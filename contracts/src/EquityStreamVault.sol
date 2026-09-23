// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20V {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title EquityStreamVault
/// @notice Lets a holder of illiquid or still-vesting tokenized equity sell it for cash today.
/// The seller locks `amount` of an equity token against a linear delivery schedule and lists an
/// ask price in USDC. A buyer pays the ask upfront; the equity then streams to the buyer as it
/// vests, claimable any time. This delivers the real token over time — it is not a cash-settled
/// derivative, and it is a different market structure from ComputeExchange's order book: one
/// seller, one buyer, escrowed delivery instead of matched trading.
contract EquityStreamVault {
    struct Stream {
        address token; // the (mock) tokenized equity
        address seller;
        address buyer; // address(0) until sold
        uint128 amount; // total equity locked
        uint128 claimed; // already claimed by the buyer
        uint64 vestStart;
        uint64 vestEnd;
        uint128 askPrice; // USDC; 0 once sold or cancelled
    }

    IERC20V public immutable usdc;
    uint256 public streamCount;
    mapping(uint256 => Stream) public streams;

    event StreamListed(uint256 indexed id, address indexed seller, address token, uint128 amount, uint64 vestStart, uint64 vestEnd, uint128 askPrice);
    event StreamCancelled(uint256 indexed id);
    event StreamBought(uint256 indexed id, address indexed buyer, uint128 askPrice);
    event StreamClaimed(uint256 indexed id, address indexed buyer, uint128 amount);

    error NotSeller();
    error NotBuyer();
    error AlreadySold();
    error NotForSale();
    error BadSchedule();
    error NothingToClaim();

    constructor(address _usdc) {
        usdc = IERC20V(_usdc);
    }

    /// @notice Lock `amount` of `token` and list it for `askPrice` USDC. Delivery streams linearly
    /// from `vestStart` to `vestEnd` once bought; `vestStart` may be in the past.
    function list(address token, uint128 amount, uint64 vestStart, uint64 vestEnd, uint128 askPrice) external returns (uint256 id) {
        if (vestEnd <= vestStart || amount == 0 || askPrice == 0) revert BadSchedule();
        require(IERC20V(token).transferFrom(msg.sender, address(this), amount), "transfer");
        id = ++streamCount;
        streams[id] = Stream(token, msg.sender, address(0), amount, 0, vestStart, vestEnd, askPrice);
        emit StreamListed(id, msg.sender, token, amount, vestStart, vestEnd, askPrice);
    }

    /// @notice Withdraw an unsold listing.
    function cancel(uint256 id) external {
        Stream storage s = streams[id];
        if (s.seller != msg.sender) revert NotSeller();
        if (s.buyer != address(0)) revert AlreadySold();
        uint128 amount = s.amount;
        address token = s.token;
        delete streams[id];
        require(IERC20V(token).transfer(msg.sender, amount), "transfer");
        emit StreamCancelled(id);
    }

    /// @notice Pay the ask and become the stream's buyer. USDC is pulled directly to the seller;
    /// the vault never custodies cash, only the escrowed equity.
    function buy(uint256 id) external {
        Stream storage s = streams[id];
        if (s.askPrice == 0) revert NotForSale();
        if (s.buyer != address(0)) revert AlreadySold();
        uint128 price = s.askPrice;
        address seller = s.seller;
        s.buyer = msg.sender;
        s.askPrice = 0;
        require(usdc.transferFrom(msg.sender, seller, price), "transfer");
        emit StreamBought(id, msg.sender, price);
    }

    /// @notice Total equity vested so far under the delivery schedule, regardless of sale status.
    function vestedAmount(uint256 id) public view returns (uint128) {
        Stream storage s = streams[id];
        if (block.timestamp <= s.vestStart) return 0;
        if (block.timestamp >= s.vestEnd) return s.amount;
        uint256 elapsed = block.timestamp - s.vestStart;
        uint256 total = s.vestEnd - s.vestStart;
        return uint128((uint256(s.amount) * elapsed) / total);
    }

    /// @notice Vested but not yet claimed. Zero until the stream is bought.
    function claimable(uint256 id) public view returns (uint128) {
        Stream storage s = streams[id];
        if (s.buyer == address(0)) return 0;
        uint128 v = vestedAmount(id);
        return v > s.claimed ? v - s.claimed : 0;
    }

    function claim(uint256 id) external returns (uint128 amount) {
        Stream storage s = streams[id];
        if (s.buyer != msg.sender) revert NotBuyer();
        amount = claimable(id);
        if (amount == 0) revert NothingToClaim();
        s.claimed += amount;
        require(IERC20V(s.token).transfer(msg.sender, amount), "transfer");
        emit StreamClaimed(id, msg.sender, amount);
    }
}
