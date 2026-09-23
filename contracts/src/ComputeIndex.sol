// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Reference price for a compute SKU (USDC per GPU-hour, 6 decimals) and
/// per-market settlement prices. Reporter-run for the hackathon: production would
/// aggregate several providers and add a dispute window.
contract ComputeIndex {
    struct Observation {
        uint128 price;
        uint64 timestamp;
    }

    address public owner;
    mapping(address => bool) public isReporter;

    mapping(bytes32 => Observation) public latest;
    mapping(uint256 => uint256) public settlementPrice;
    mapping(uint256 => bool) public hasSettlement;

    event IndexReported(bytes32 indexed sku, uint256 price, uint256 timestamp);
    event SettlementReported(uint256 indexed marketId, uint256 price);

    error NotReporter();
    error AlreadyReported();

    constructor() {
        owner = msg.sender;
        isReporter[msg.sender] = true;
    }

    function setReporter(address who, bool allowed) external {
        require(msg.sender == owner, "owner");
        isReporter[who] = allowed;
    }

    function reportIndex(bytes32 sku, uint256 price) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        latest[sku] = Observation(uint128(price), uint64(block.timestamp));
        emit IndexReported(sku, price, block.timestamp);
    }

    function reportSettlement(uint256 marketId, uint256 price) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        if (hasSettlement[marketId]) revert AlreadyReported();
        hasSettlement[marketId] = true;
        settlementPrice[marketId] = price;
        emit SettlementReported(marketId, price);
    }
}
