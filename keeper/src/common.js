import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, stringToHex, hexToString } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

export const abi = {
  exchange: load("../abi/exchange.json"),
  index: load("../abi/index.json"),
  usdc: load("../abi/usdc.json"),
};

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);

export const chain = defineChain({
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const deployment = load(`../../contracts/deployments/${CHAIN_ID}.json`);

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

export function walletFor(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    client: createWalletClient({ account, chain, transport: http(RPC_URL) }),
  };
}

export const keys = (name) =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const exchange = { address: deployment.exchange, abi: abi.exchange };
export const indexC = { address: deployment.index, abi: abi.index };
export const usdc = { address: deployment.usdc, abi: abi.usdc };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const skuToHex = (s) => stringToHex(s, { size: 32 });
export const skuFromHex = (h) => hexToString(h, { size: 32 }).replace(/\0+$/, "");

export async function send(wallet, contract, functionName, args = []) {
  const hash = await wallet.client.writeContract({ ...contract, functionName, args });
  return publicClient.waitForTransactionReceipt({ hash });
}

export async function listMarkets() {
  const count = await publicClient.readContract({ ...exchange, functionName: "marketCount" });
  const out = [];
  for (let id = 1n; id <= count; id++) {
    const m = await publicClient.readContract({ ...exchange, functionName: "markets", args: [id] });
    out.push({
      id,
      sku: m[0],
      closeTime: m[1],
      settleTime: m[2],
      maxTick: m[3],
      tickSize: m[4],
      settled: m[5],
    });
  }
  return out;
}

export async function chainTime() {
  const b = await publicClient.getBlock();
  return b.timestamp;
}
