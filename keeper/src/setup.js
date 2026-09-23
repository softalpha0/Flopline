// Mints test USDC to every maker/taker key, approves the exchange, and deposits collateral.
import { parseUnits } from "viem";
import { walletFor, keys, send, usdc, exchange } from "./common.js";

const AMOUNT = parseUnits(process.env.FUND_USDC ?? "50000", 6);
const all = [...keys("MAKER_KEYS"), ...keys("TAKER_KEYS")];
if (!all.length) throw new Error("Set MAKER_KEYS and/or TAKER_KEYS (comma-separated private keys)");

for (const k of all) {
  const w = walletFor(k);
  await send(w, usdc, "mint", [w.account.address, AMOUNT]);
  await send(w, usdc, "approve", [exchange.address, AMOUNT]);
  await send(w, exchange, "deposit", [AMOUNT]);
  console.log(`funded ${w.account.address} with ${AMOUNT / 1_000_000n} USDC`);
}
