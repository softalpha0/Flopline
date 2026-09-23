import { createPublicClient, createWalletClient, defineChain, http, type Address, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import exchangeAbi from "./abi/exchange.json";
import indexAbi from "./abi/index.json";
import usdcAbi from "./abi/usdc.json";
import equityVaultAbi from "./abi/equityVault.json";
import mockEquityAbi from "./abi/mockEquity.json";

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";

const files = import.meta.glob("../../contracts/deployments/*.json", { eager: true, import: "default" }) as Record<
  string,
  { usdc: Address; index: Address; exchange: Address; equityVault: Address; mockEquity: Address }
>;
const key = Object.keys(files).find((k) => k.endsWith(`/${CHAIN_ID}.json`));
if (!key) throw new Error(`No deployment found for chain ${CHAIN_ID}. Run the deploy script first.`);
export const deployment = files[key];

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 31337 ? "Local" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

export const exchange = { address: deployment.exchange, abi: exchangeAbi } as const;
export const indexC = { address: deployment.index, abi: indexAbi } as const;
export const usdc = { address: deployment.usdc, abi: usdcAbi } as const;
export const equityVault = { address: deployment.equityVault, abi: equityVaultAbi } as const;
export const mockEquity = { address: deployment.mockEquity, abi: mockEquityAbi } as const;

export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? "http://localhost:8787";

let current: LocalAccount | undefined;
export const setAccount = (a?: LocalAccount) => {
  current = a;
};
export function getAccount(): LocalAccount {
  if (!current) throw new Error("Not signed in");
  return current;
}
export const walletClient = () => createWalletClient({ account: getAccount(), chain, transport: http(RPC_URL) });

// Testnet-only fallback for browsers without passkey PRF support.
export function burnerAccount(): LocalAccount {
  let pk = localStorage.getItem("flopline.devkey") as `0x${string}` | null;
  if (!pk) {
    pk = generatePrivateKey();
    localStorage.setItem("flopline.devkey", pk);
  }
  return privateKeyToAccount(pk);
}
