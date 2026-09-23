// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/MockUSDC.sol";
import "../src/ComputeIndex.sol";
import "../src/ComputeExchange.sol";
import "../src/PairMinter.sol";
import "../src/MockEquity.sol";
import "../src/EquityStreamVault.sol";

/// Usage: PRIVATE_KEY=0x... [USDC=0x...] [MARKET_CAP_USDC=...] [USER_CAP_USDC=...] forge script script/Deploy.s.sol --rpc-url <url> --broadcast
/// If USDC is set (for example Kuru's testnet USDC, or real USDC on mainnet) it is used as collateral;
/// otherwise a freely-mintable MockUSDC is deployed, which is fine for local/testnet but means nothing
/// traded has real value. MARKET_CAP_USDC / USER_CAP_USDC (6dp, e.g. 500000000 = $500) are enforced
/// onchain per market; leave unset (0) for uncapped local/testnet use, set them for a mainnet beta.
contract Deploy is Script {
    uint32 constant MAX_TICK = 1000; // $10.00 ceiling per GPU-hour
    uint128 constant TICK = 10_000; // $0.01

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address usdcAddr = vm.envOr("USDC", address(0));
        uint128 marketCap = uint128(vm.envOr("MARKET_CAP_USDC", uint256(0)));
        uint128 userCap = uint128(vm.envOr("USER_CAP_USDC", uint256(0)));
        bool usingMockUsdc = usdcAddr == address(0);
        vm.startBroadcast(pk);

        if (usingMockUsdc) usdcAddr = address(new MockUSDC());
        ComputeIndex index = new ComputeIndex();
        ComputeExchange ex = new ComputeExchange(usdcAddr, address(index));
        PairMinter pairMinter = new PairMinter(usdcAddr, address(ex));

        MockEquity equity = new MockEquity("Tokenized NVDA (mock)", "mNVDA");
        EquityStreamVault equityVault = new EquityStreamVault(usdcAddr);

        uint64 t = uint64(block.timestamp);
        // Market 1: one-hour market so a full settle-and-claim dry run fits in a demo.
        ex.createMarket("H100-USEAST-DRYRUN", t + 1 hours, t + 90 minutes, MAX_TICK, TICK, marketCap, userCap);
        // Markets 2-3: weekly delivery contracts.
        ex.createMarket("H100-USEAST-WK1", t + 7 days, t + 14 days, MAX_TICK, TICK, marketCap, userCap);
        ex.createMarket("H100-USEAST-WK2", t + 14 days, t + 21 days, MAX_TICK, TICK, marketCap, userCap);

        vm.stopBroadcast();

        if (usingMockUsdc) {
            console.log("WARNING: collateral is a freely-mintable MockUSDC. Nothing traded has real value.");
            console.log("Set USDC=<real token address> to deploy with real collateral.");
        }
        if (marketCap == 0 || userCap == 0) {
            console.log("WARNING: MARKET_CAP_USDC and/or USER_CAP_USDC unset -- markets are UNCAPPED.");
        }
        console.log("USDC", usdcAddr);
        console.log("INDEX", address(index));
        console.log("EXCHANGE", address(ex));
        console.log("PAIR_MINTER", address(pairMinter));
        console.log("MOCK_EQUITY", address(equity));
        console.log("EQUITY_VAULT", address(equityVault));

        string memory json = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"usdc":"', vm.toString(usdcAddr),
            '","index":"', vm.toString(address(index)),
            '","exchange":"', vm.toString(address(ex)),
            '","pairMinter":"', vm.toString(address(pairMinter)),
            '","mockEquity":"', vm.toString(address(equity)),
            '","equityVault":"', vm.toString(address(equityVault)),
            '","deployedAt":', vm.toString(block.timestamp), "}"
        );
        vm.writeFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"), json);
    }
}
