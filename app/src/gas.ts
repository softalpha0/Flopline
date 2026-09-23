import { CHAIN_ID, RPC_URL, SERVER_URL } from "./chain";

/// Makes sure `address` can pay gas before a write. On local anvil this sets the balance directly;
/// on a real testnet it asks the backend's faucet drip. Safe to call before every write — both
/// paths are idempotent no-ops once the account already has enough.
export async function ensureGas(address: `0x${string}`) {
  if (CHAIN_ID === 31337) {
    await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, "0x3635C9ADC5DEA00000"] }),
    });
    return;
  }
  const r = await fetch(`${SERVER_URL}/drip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? "gas request failed");
}
