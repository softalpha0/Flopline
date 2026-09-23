# Flopline

Mobile-first exchange for standardized, cash-settled GPU-hour contracts on Monad.

## Layout

- `contracts/` Foundry project: `ComputeExchange` (order book, collateral, settlement), `ComputeIndex` (reference and settlement price), `MockUSDC`.
- `keeper/` Node scripts: index poster and settler, simulated market makers, scripted takers.

## Contracts

```bash
cd contracts
forge test
PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast
```

The deploy script writes `contracts/deployments/<chainId>.json`, which the keeper reads. It creates three markets: a one-hour dry-run market and two weekly markets.

## Keeper

```bash
cd keeper
npm install
export RPC_URL=<rpc> CHAIN_ID=<id>
export REPORTER_KEY=0x...            # deployer key (a reporter on ComputeIndex)
export MAKER_KEYS=0x..,0x..,0x..     # simulated makers
export TAKER_KEYS=0x..,0x..          # test takers
npm run setup    # mint test USDC, approve, deposit
npm run index    # post index price, settle expired markets
npm run maker    # quote ladders around the index
npm run taker    # cross the spread to generate trades
```

Simulated makers are test infrastructure and must be labelled as simulated in any demo.

## App

```bash
cd app
npm install
npm run dev   # http://localhost:5173
```

Reads `contracts/deployments/<chainId>.json`. Set `VITE_CHAIN_ID` and `VITE_RPC_URL` for a network other than local anvil (31337). The app uses a temporary burner account in the browser; Mera passkey sign-in replaces it.

## Indexer (Envio)

`indexer/` holds the HyperIndex config, schema, and handlers. Envio's CLI does not run on Windows: use Linux, macOS, WSL2, or a Codespace, and install Docker. Set the exchange address and start block in `indexer/config.yaml`, then `npm run codegen && npm run dev`. The handlers have not been run yet.
