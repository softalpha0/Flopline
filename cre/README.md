# CRE workflow

`flopline-index/main.ts` reads three GPU-hour price feeds, takes the median, and writes the index onchain through `CREIndexReceiver`.

Status: written from Chainlink's docs, not yet simulated. It needs a human step first: creating a CRE account and logging in.

## Run the simulation

1. Install the CLI (Windows PowerShell): `irm https://app.chain.link/cre/install.ps1 | iex`, then `cre version`.
2. Create an account at https://app.chain.link/cre/discover and run `cre login`.
3. Scaffold a TypeScript project with `cre init`, then copy `flopline-index/main.ts` and `config.staging.json` over the generated workflow files (keep the generated `package.json`, `workflow.yaml`, and `project.yaml`).
4. Run `cre workflow supported-chains --output json` and set `chainName` to the exact Monad testnet name; note the forwarder address.
5. Deploy `CREIndexReceiver` with that forwarder, make it a reporter on `ComputeIndex` (`setReporter`), and put its address in `receiverAddress`.
6. Start the local price feeds (`server/`, `npm run feeds`) and run `cre workflow simulate flopline-index`.

The source feeds are simulated for the hackathon. Production uses real provider APIs with keys held as CRE secrets.
