// Chainlink CRE workflow: reads several GPU-hour price sources, takes the median, and writes the
// reference index to Flopline's ComputeIndex through the CREIndexReceiver consumer contract.
import {
  CronCapability,
  HTTPClient,
  EVMClient,
  TxStatus,
  handler,
  consensusMedianAggregation,
  Runner,
  getNetwork,
  bytesToHex,
  hexToBase64,
  type Runtime,
  type HTTPSendRequester,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters, stringToHex } from "viem";

type Source = { name: string; url: string; path: string };
type MarketCfg = { sku: string; premiumBps: number };

export type Config = {
  schedule: string;
  chainName: string; // e.g. "monad-testnet" (confirmed via `cre workflow supported-chains`)
  receiverAddress: string; // CREIndexReceiver
  gasLimit: string;
  sources: Source[];
  markets: MarketCfg[];
};

// Reads one number out of a JSON body by dotted path, e.g. "h100.usd_per_hour".
const readSource = (sendRequester: HTTPSendRequester, src: Source): number => {
  const resp = sendRequester.sendRequest({ url: src.url, method: "GET" }).result();
  if (resp.statusCode !== 200) throw new Error(`${src.name}: HTTP ${resp.statusCode}`);
  let node: unknown = JSON.parse(new TextDecoder().decode(resp.body));
  for (const key of src.path.split(".")) node = (node as Record<string, unknown>)[key];
  const n = Number(node);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${src.name}: bad price`);
  return n;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const http = new HTTPClient();

  // Each source is fetched by every node; the DON agrees on the median across nodes per source.
  const prices: number[] = [];
  for (const src of cfg.sources) {
    try {
      prices.push(http.sendRequest(runtime, readSource, consensusMedianAggregation<number>())(src).result());
    } catch (e) {
      runtime.log(`source ${src.name} failed: ${(e as Error).message}`);
    }
  }
  if (prices.length < 2) throw new Error(`only ${prices.length} sources responded; refusing to publish`);

  const base = median(prices);
  runtime.log(`median of ${prices.length} sources: $${base.toFixed(4)}`);

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainName });
  if (!network) throw new Error(`unknown chain ${cfg.chainName}`);
  const evm = new EVMClient(network.chainSelector.selector);

  for (const m of cfg.markets) {
    const usd = base * (1 + m.premiumBps / 10_000);
    const price = BigInt(Math.round(usd * 1e6)); // USDC, 6 decimals
    const payload = encodeAbiParameters(parseAbiParameters("uint8 kind, bytes32 sku, uint256 marketId, uint256 price"), [
      0,
      stringToHex(m.sku, { size: 32 }),
      0n,
      price,
    ]);
    const report = runtime
      .report({ encodedPayload: hexToBase64(payload), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
      .result();
    const write = evm
      .writeReport(runtime, { receiver: cfg.receiverAddress, report, gasConfig: { gasLimit: cfg.gasLimit } })
      .result();
    if (write.txStatus !== TxStatus.SUCCESS) {
      throw new Error(`${m.sku}: write failed (${TxStatus[write.txStatus]}) ${write.errorMessage ?? ""}`);
    }
    runtime.log(`${m.sku} = $${usd.toFixed(4)} tx ${bytesToHex(write.txHash ?? new Uint8Array())}`);
  }
  return `published ${cfg.markets.length} index prices`;
};

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCronTrigger),
];

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
