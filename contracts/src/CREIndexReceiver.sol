// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC165Min {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IComputeIndexWrite {
    function reportIndex(bytes32 sku, uint256 price) external;
    function reportSettlement(uint256 marketId, uint256 price) external;
}

/// @notice Chainlink CRE consumer. The KeystoneForwarder calls `onReport` with a DON-signed report;
/// this contract decodes it and writes to ComputeIndex. It must be a reporter on ComputeIndex.
/// Report payload: abi.encode(uint8 kind, bytes32 sku, uint256 marketId, uint256 price)
///   kind 0 = index observation for `sku`, kind 1 = settlement price for `marketId`.
contract CREIndexReceiver is IReceiver, IERC165Min {
    IComputeIndexWrite public immutable index;
    address public owner;
    address public forwarder;
    address public expectedWorkflowOwner; // optional: 0 disables the check

    event ReportReceived(uint8 kind, bytes32 sku, uint256 marketId, uint256 price);

    error NotForwarder();
    error WrongWorkflowOwner();
    error BadKind();

    constructor(address _index, address _forwarder) {
        index = IComputeIndexWrite(_index);
        forwarder = _forwarder;
        owner = msg.sender;
    }

    function setForwarder(address f) external {
        require(msg.sender == owner, "owner");
        forwarder = f;
    }

    function setExpectedWorkflowOwner(address w) external {
        require(msg.sender == owner, "owner");
        expectedWorkflowOwner = w;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder();
        if (expectedWorkflowOwner != address(0) && _workflowOwner(metadata) != expectedWorkflowOwner) {
            revert WrongWorkflowOwner();
        }

        (uint8 kind, bytes32 sku, uint256 marketId, uint256 price) = abi.decode(report, (uint8, bytes32, uint256, uint256));
        if (kind == 0) {
            index.reportIndex(sku, price);
        } else if (kind == 1) {
            index.reportSettlement(marketId, price);
        } else {
            revert BadKind();
        }
        emit ReportReceived(kind, sku, marketId, price);
    }

    /// Metadata layout: workflowId (32 bytes) | workflowName (10 bytes) | workflowOwner (20 bytes) | ...
    function _workflowOwner(bytes calldata metadata) private pure returns (address w) {
        require(metadata.length >= 62, "metadata");
        w = address(bytes20(metadata[42:62]));
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165Min).interfaceId;
    }
}
