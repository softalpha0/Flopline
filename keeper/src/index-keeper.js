// Posts a simulated GPU-hour reference price for each market SKU and settles markets past their settle time.
// Production replaces this with the Chainlink CRE workflow (median of several price sources).
import { walletFor, keys, send, sleep, publicClient, exchange, indexC, listMarkets, chainTime, skuFromHex } from "./common.js";

const [reporterKey] = keys("REPORTER_KEY");
if (!reporterKey) throw new Error("Set REPORTER_KEY (must be a reporter on ComputeIndex; the deployer is by default)");
const wallet = walletFor(reporterKey);

const INTERVAL_MS = Number(process.env.INDEX_INTERVAL_MS ?? 15000);
const BASE_USD = Number(process.env.INDEX_BASE_USD ?? 2.5);
const VOL = Number(process.env.INDEX_VOL ?? 0.01);

let base = BASE_USD;
const toUnits = (usd) => BigInt(Math.round(usd * 1e6));

async function tick() {
  base = Math.max(0.5, base * (1 + (Math.random() - 0.5) * 2 * VOL));
  const markets = await listMarkets();
  const now = await chainTime();

  for (const [i, m] of markets.entries()) {
    const price = toUnits(base * (1 + 0.01 * i)); // small term structure across delivery weeks
    if (!m.settled && now < m.settleTime) {
      await send(wallet, indexC, "reportIndex", [m.sku, price]);
      console.log(`index ${skuFromHex(m.sku)} = $${(Number(price) / 1e6).toFixed(4)}`);
    }
    if (!m.settled && now >= m.settleTime) {
      const has = await publicClient.readContract({ ...indexC, functionName: "hasSettlement", args: [m.id] });
      if (!has) {
        const latest = await publicClient.readContract({ ...indexC, functionName: "latest", args: [m.sku] });
        await send(wallet, indexC, "reportSettlement", [m.id, latest[0]]);
        console.log(`settlement reported for market ${m.id}: $${(Number(latest[0]) / 1e6).toFixed(4)}`);
      }
      await send(wallet, exchange, "settle", [m.id]);
      console.log(`market ${m.id} settled`);
    }
  }
}

for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error("index keeper error:", e.shortMessage ?? e.message);
  }
  await sleep(INTERVAL_MS);
}
