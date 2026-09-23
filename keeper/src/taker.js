// Scripted takers that cross the spread to generate real test trades against the book.
import { walletFor, keys, send, sleep, publicClient, exchange, listMarkets, chainTime } from "./common.js";

const takerKeys = keys("TAKER_KEYS");
if (!takerKeys.length) throw new Error("Set TAKER_KEYS (comma-separated private keys)");
const wallets = takerKeys.map(walletFor);
const TRADES = Number(process.env.TAKER_TRADES ?? 20);
const INTERVAL_MS = Number(process.env.TAKER_INTERVAL_MS ?? 2000);

const now = await chainTime();
const markets = (await listMarkets()).filter((m) => now < m.closeTime);
if (!markets.length) throw new Error("no open markets");

for (let n = 0; n < TRADES; n++) {
  const w = wallets[n % wallets.length];
  const m = markets[n % markets.length];
  const isBuy = Math.random() < 0.5;
  const [ok, tick] = await publicClient.readContract({
    ...exchange,
    functionName: isBuy ? "bestAsk" : "bestBid",
    args: [m.id],
  });
  if (!ok) {
    console.log(`market ${m.id}: empty ${isBuy ? "ask" : "bid"} side, skipping`);
    continue;
  }
  const qty = 1n + BigInt(Math.floor(Math.random() * 10));
  try {
    // crossing limit at the best price on the other side = immediate fill, no resting remainder
    const r = await send(w, exchange, "placeOrder", [m.id, isBuy, tick, qty, true]);
    console.log(`${isBuy ? "BUY " : "SELL"} ${qty} @ tick ${tick} market ${m.id} tx ${r.transactionHash.slice(0, 10)} (${r.status})`);
  } catch (e) {
    console.error("taker error:", e.shortMessage ?? e.message);
  }
  await sleep(INTERVAL_MS);
}
