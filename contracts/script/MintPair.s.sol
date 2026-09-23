// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";

interface IERC20Mintable {
    function faucet() external;
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPairMinter {
    function mint(uint256 marketId, uint256 amount) external;
    function pairs(uint256 marketId) external view returns (address long, address short);
}

/// One-off: mint a long/short token pair for the WK2 market (marketId 3) so we have real,
/// deployed token addresses to hand Kuru for listing.
/// Usage: forge script script/MintPair.s.sol --rpc-url https://testnet-rpc.monad.xyz --broadcast
contract MintPair is Script {
    address constant USDC = 0xeA19DeF11d44bF13c4655210e95f8aa3407cDE04;
    address constant PAIR_MINTER = 0x3B886a3f5A60BF088C9f3ff0fA0A85F10F3Ed1F2;
    uint256 constant MARKET_ID = 3; // WK2: DRYRUN=1, WK1=2, WK2=3
    uint256 constant AMOUNT = 10e6; // 10 GPU-hours -> costs 10 * $10 max price = $100 mock USDC

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        IERC20Mintable(USDC).faucet();
        IERC20Mintable(USDC).approve(PAIR_MINTER, type(uint256).max);
        IPairMinter(PAIR_MINTER).mint(MARKET_ID, AMOUNT);

        vm.stopBroadcast();

        (address long, address short) = IPairMinter(PAIR_MINTER).pairs(MARKET_ID);
        console.log("LONG_TOKEN", long);
        console.log("SHORT_TOKEN", short);
    }
}
