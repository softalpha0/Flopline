import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { LocalAccount } from "viem";

const STORE = "flopline.credential";
const EVM_PATH = "m/44'/60'/0'/0/0";

type Stored = { credentialId: string; transports?: string[] };

export type Session = { account: LocalAccount; end: () => void };

export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential;
export const hasStoredPasskey = () => !!localStorage.getItem(STORE);

function sessionFromPrf(prfOutput: Uint8Array): Session {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(EVM_PATH);
  if (node.privateKey === null) throw new Error("key derivation failed");
  const signing = createSecp256k1SigningSession({ privateKey: node.privateKey });
  return { account: toViemAccount(signing) as LocalAccount, end: () => signing.end() };
}

export async function createPasskeyAccount(label: string): Promise<Session> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: location.hostname, name: "Flopline" },
    user: { name: label, displayName: label },
  });
  localStorage.setItem(STORE, JSON.stringify({ credentialId: created.credentialId, transports: created.transports }));
  return sessionFromPrf(created.prfOutput);
}

export async function signInWithPasskey(): Promise<Session> {
  const stored = localStorage.getItem(STORE);
  const known: Stored | undefined = stored ? JSON.parse(stored) : undefined;
  const { prfOutput, credentialId } = await getPasskeyPrfOutput({
    rpId: location.hostname,
    credential: known as never,
  });
  if (known?.credentialId !== credentialId) localStorage.setItem(STORE, JSON.stringify({ credentialId }));
  return sessionFromPrf(prfOutput);
}
