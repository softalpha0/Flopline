// Simulated market makers. Each key quotes a ladder around the index price and requotes when the index moves.
import { parseEventLogs } from "viem";
import { walletFor, keys, send, sleep, publicClient, exchange, indexC, listMarkets, chainTime, skuFromHex } from "./common.js";

const makerKeys = keys("MAKER_KEYS");
if (!makerKeys.length) throw new Error("Set MAKER_KEYS (comma-separated private keys)");

const INTERVAL_MS = Number(process.env.MM_INTERVAL_MS ?? 10000);
const LEVELS = Number(process.env.MM_LEVELS ?? 5);
const STEP = Number(process.env.MM_STEP_TICKS ?? 2);
const REQUOTE_TICKS = Number(process.env.MM_REQUOTE_TICKS ?? 2);

const makers = makerKeys.map((k, i) => ({
  wallet: walletFor(k),
  spread: 1 + i, // wider spread for later makers
  orderIds: new Map(), // marketId -> [orderId]
  lastMid: new Map(), // marketId -> tick
}));

async function midTick(m) {
  const obs = await publicClient.readContract({ ...indexC, functionName: "latest", args: [m.sku] });
  const price = obs[0] === 0n ? 2_500_000n : obs[0];
  const t = Number(price / m.tickSize);
  return Math.min(Number(m.maxTick) - 20, Math.max(20, t));
}

async function requote(maker, m, mid) {
  const prev = maker.orderIds.get(m.id) ?? [];
  for (const id of prev) {
    try {
      await send(maker.wallet, exchange, "cancelOrder", [id]);
    } catch {
      /* already filled or cancelled */
    }
  }
  const placed = [];
  for (let i = 0; i < LEVELS; i++) {
    for (const isBid of [true, false]) {
      const tick = isBid ? mid - maker.spread - i * STEP : mid + maker.spread + i * STEP;
      const qty = 20n + BigInt(Math.floor(Math.random() * 40));
      try {
        const r = await send(maker.wallet, exchange, "placeOrder", [m.id, isBid, tick, qty, false]);
        const logs = parseEventLogs({ abi: exchange.abi, logs: r.logs, eventName: "OrderPlaced" });
        for (const l of logs) placed.push(l.args.orderId);
      } catch (e) {
        console.error(`maker ${maker.wallet.account.address.slice(0, 8)} place failed:`, e.shortMessage ?? e.message);
      }
    }
  }
  maker.orderIds.set(m.id, placed);
  maker.lastMid.set(m.id, mid);
  console.log(`maker ${maker.wallet.account.address.slice(0, 8)} quoted ${skuFromHex(m.sku)} around tick ${mid}`);
}

for (;;) {
  try {
    const now = await chainTime();
    const markets = (await listMarkets()).filter((m) => now < m.closeTime);
    for (const m of markets) {
      const mid = await midTick(m);
      for (const maker of makers) {
        const last = maker.lastMid.get(m.id);
        if (last === undefined || Math.abs(mid - last) >= REQUOTE_TICKS) await requote(maker, m, mid);
      }
    }
  } catch (e) {
    console.error("market maker error:", e.shortMessage ?? e.message);
  }
  await sleep(INTERVAL_MS);
}
