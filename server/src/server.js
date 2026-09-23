// Small backend for things the browser must not do itself:
//   GET  /feed/a|b|c        simulated GPU-hour price feeds read by the Chainlink CRE workflow
//   POST /drip              send a little gas to a new passkey account (testnet only)
//   POST /deposit-address   create an Aurora Intents persistent deposit address (API key stays here)
import { createServer } from "node:http";
import { createPublicClient, createWalletClient, defineChain, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PORT = Number(process.env.PORT ?? 8787);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const DRIP_KEY = process.env.DRIP_KEY;
const DRIP_AMOUNT = process.env.DRIP_AMOUNT ?? "0.3";
const DRIP_MIN_BALANCE = parseEther(process.env.DRIP_MIN_BALANCE ?? "0.05");
const AURORA_API_KEY = process.env.AURORA_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
const SOURCE_CHAINS = new Set(["eth", "base", "arb", "op", "polygon", "monad", "evm"]);

const chain = defineChain({
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const dripper = DRIP_KEY ? createWalletClient({ account: privateKeyToAccount(DRIP_KEY), chain, transport: http(RPC_URL) }) : null;
const dripped = new Map(); // address -> timestamp

const cors = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify(body));
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 10_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });

// Simulated feeds: a slow wave around $2.50 with a small offset per feed.
const FEEDS = { a: -0.01, b: 0, c: 0.02 };
const feedPrice = (offset) => 2.5 + 0.15 * Math.sin(Date.now() / 600_000) + offset;

const routes = {
  async "GET /feed"(_req, res, parts) {
    const offset = FEEDS[parts[1]];
    if (offset === undefined) return send(res, 404, { error: "unknown feed" });
    send(res, 200, { h100: { usd_per_hour: Number(feedPrice(offset).toFixed(4)) }, updatedAt: Date.now() });
  },

  async "POST /drip"(req, res) {
    if (!dripper) return send(res, 503, { error: "drip disabled (set DRIP_KEY)" });
    const { address } = await readJson(req);
    if (!isAddress(address)) return send(res, 400, { error: "bad address" });
    const key = address.toLowerCase();
    if (Date.now() - (dripped.get(key) ?? 0) < 24 * 3600 * 1000) return send(res, 429, { error: "already dripped today" });
    const balance = await publicClient.getBalance({ address });
    if (balance >= DRIP_MIN_BALANCE) return send(res, 200, { skipped: true, reason: "balance sufficient" });
    dripped.set(key, Date.now());
    const hash = await dripper.sendTransaction({ to: address, value: parseEther(DRIP_AMOUNT) });
    send(res, 200, { hash });
  },

  async "POST /deposit-address"(req, res) {
    if (!AURORA_API_KEY) return send(res, 503, { error: "Aurora disabled (set AURORA_API_KEY from studio.aurora.dev)" });
    const { recipient, depositChain } = await readJson(req);
    if (!isAddress(recipient)) return send(res, 400, { error: "bad recipient" });
    if (!SOURCE_CHAINS.has(depositChain)) return send(res, 400, { error: "unsupported depositChain" });
    const r = await fetch(`https://intents-api.aurora.dev/api/persistent-deposit-address/${AURORA_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient,
        sender: recipient.toLowerCase(),
        depositChain,
        destinationChain: "monad",
        destinationAsset: "USDC",
        confidential: false,
      }),
    });
    const body = await r.json().catch(() => ({}));
    send(res, r.ok ? 200 : 502, r.ok ? { depositAddress: body.depositAddress, alreadyExists: body.alreadyExists } : { error: "aurora request failed", status: r.status });
  },
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  try {
    const parts = new URL(req.url, "http://x").pathname.split("/").filter(Boolean);
    const handler = routes[`${req.method} /${parts[0]}`];
    if (!handler) return send(res, 404, { error: "not found" });
    await handler(req, res, parts);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`flopline server on :${PORT}`));
