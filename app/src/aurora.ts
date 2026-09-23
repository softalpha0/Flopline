// Aurora Intents persistent deposit address: gives the user one address that accepts funds from
// any of 31+ source chains and routes them to arrive as USDC on this chain, at their own wallet.
// The API key lives on the server (server/src/server.js /deposit-address), never in the browser.
import type { Address } from "viem";
import { SERVER_URL } from "./chain";

export const SOURCE_CHAINS = [
  { id: "eth", label: "Ethereum" },
  { id: "base", label: "Base" },
  { id: "arb", label: "Arbitrum" },
  { id: "op", label: "Optimism" },
  { id: "polygon", label: "Polygon" },
  { id: "evm", label: "Other EVM chain" },
] as const;

export type SourceChainId = (typeof SOURCE_CHAINS)[number]["id"];

export async function getAuroraDepositAddress(recipient: Address, depositChain: SourceChainId): Promise<Address> {
  const r = await fetch(`${SERVER_URL}/deposit-address`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient, depositChain }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? "deposit address request failed");
  return body.depositAddress as Address;
}
