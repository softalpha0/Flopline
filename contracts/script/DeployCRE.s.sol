// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/ComputeIndex.sol";
import "../src/CREIndexReceiver.sol";

/// Deploys the CRE consumer and grants it the reporter role on ComputeIndex.
/// Usage: PRIVATE_KEY=0x... INDEX=0x... FORWARDER=0x... forge script script/DeployCRE.s.sol --rpc-url <url> --broadcast
/// PRIVATE_KEY must be the ComputeIndex owner. FORWARDER comes from `cre workflow supported-chains --output json`.
contract DeployCRE is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address index = vm.envAddress("INDEX");
        address forwarder = vm.envAddress("FORWARDER");

        vm.startBroadcast(pk);
        CREIndexReceiver rx = new CREIndexReceiver(index, forwarder);
        ComputeIndex(index).setReporter(address(rx), true);
        vm.stopBroadcast();

        console.log("CRE_RECEIVER", address(rx));
    }
}
