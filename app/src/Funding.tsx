import { useEffect, useState } from "react";
import { CHAIN_ID, exchange, getAccount, publicClient, usdc, walletClient } from "./chain";
import { fundViaKuruSwap, kuruAvailable, type FundStep } from "./kuru";
import { getAuroraDepositAddress, SOURCE_CHAINS, type SourceChainId } from "./aurora";
import { ensureGas } from "./gas";
import { usd } from "./format";

const STEP_LABEL: Record<FundStep, string> = {
  "depositing-mon": "Depositing MON into Kuru...",
  swapping: "Swapping MON for USDC on Kuru...",
  "withdrawing-usdc": "Withdrawing USDC from Kuru...",
  approving: "Approving Flopline...",
  "depositing-flopline": "Depositing into Flopline...",
  done: "Done.",
};

export function Funding({ free, wallet, onDone }: { free: bigint; wallet: bigint; onDone: () => void }) {
  const account = getAccount();
  const [native, setNative] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    const load = () => publicClient.getBalance({ address: account.address }).then(setNative).catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [account.address]);

  async function getGas() {
    setBusy(true);
    setErr(undefined);
    try {
      await ensureGas(account.address);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addFunds() {
    setBusy(true);
    setErr(undefined);
    try {
      await ensureGas(account.address);
      const w = walletClient();
      const amount = 10_000n * 1_000_000n;
      const step = async (p: Promise<`0x${string}`>) => publicClient.waitForTransactionReceipt({ hash: await p });
      await step(w.writeContract({ ...usdc, functionName: "faucet" }));
      await step(w.writeContract({ ...usdc, functionName: "approve", args: [exchange.address, amount] }));
      await step(w.writeContract({ ...exchange, functionName: "deposit", args: [amount] }));
      onDone();
    } catch (e) {
      const x = e as { shortMessage?: string; message: string };
      setErr(x.shortMessage ?? x.message);
    } finally {
      setBusy(false);
    }
  }

  async function depositWalletUsdc() {
    if (wallet === 0n) return;
    setBusy(true);
    setErr(undefined);
    try {
      await ensureGas(account.address);
      const w = walletClient();
      const step = async (p: Promise<`0x${string}`>) => publicClient.waitForTransactionReceipt({ hash: await p });
      await step(w.writeContract({ ...usdc, functionName: "approve", args: [exchange.address, wallet] }));
      await step(w.writeContract({ ...exchange, functionName: "deposit", args: [wallet] }));
      onDone();
    } catch (e) {
      const x = e as { shortMessage?: string; message: string };
      setErr(x.shortMessage ?? x.message);
    } finally {
      setBusy(false);
    }
  }

  const [auroraChain, setAuroraChain] = useState<SourceChainId>("eth");
  const [auroraAddress, setAuroraAddress] = useState<string>();
  const [auroraErr, setAuroraErr] = useState<string>();

  async function requestAuroraAddress() {
    setBusy(true);
    setAuroraErr(undefined);
    setAuroraAddress(undefined);
    try {
      const addr = await getAuroraDepositAddress(account.address, auroraChain);
      setAuroraAddress(addr);
    } catch (e) {
      setAuroraErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [kuruMon, setKuruMon] = useState("1");
  const [kuruStep, setKuruStep] = useState<FundStep>();
  const [kuruErr, setKuruErr] = useState<string>();

  async function fundFromKuru() {
    const amount = /^\d*\.?\d+$/.test(kuruMon) ? BigInt(Math.round(parseFloat(kuruMon) * 1e18)) : 0n;
    if (amount === 0n) return;
    setBusy(true);
    setKuruErr(undefined);
    setKuruStep(undefined);
    try {
      const { usdcReceived } = await fundViaKuruSwap(amount, setKuruStep);
      onDone();
      setKuruErr(`Received ${usd(usdcReceived)} USDC from Kuru and deposited it.`);
    } catch (e) {
      const x = e as { shortMessage?: string; message: string };
      setKuruErr(x.shortMessage ?? x.message);
    } finally {
      setBusy(false);
    }
  }

  const noGas = native === 0n;
  return (
    <section className="card">
      <div className="kv">
        <span className="muted">Trading balance</span>
        <b>{usd(free)}</b>
      </div>
      <div className="kv small">
        <span className="muted">Test account</span>
        <code>
          {account.address.slice(0, 6)}...{account.address.slice(-4)}
        </code>
      </div>
      {wallet > 0n && (
        <div className="kv small">
          <span className="muted">{usd(wallet)} USDC is in your wallet, not yet deposited</span>
          <button className="link" disabled={busy} onClick={depositWalletUsdc}>
            Deposit
          </button>
        </div>
      )}
      {noGas && CHAIN_ID !== 31337 && (
        <>
          <p className="warn">This account has no MON for gas yet.</p>
          <button className="cta ghost" disabled={busy} onClick={getGas}>
            Get test gas
          </button>
        </>
      )}
      <button className="cta ghost" disabled={busy || (noGas && CHAIN_ID !== 31337)} onClick={addFunds}>
        {busy ? "Adding funds..." : "Add $10,000 test funds"}
      </button>
      {err && <p className="warn">{err}</p>}

      {kuruAvailable() && (
        <>
          <div className="fields" style={{ gridTemplateColumns: "1fr auto" }}>
            <label>
              Fund with MON via Kuru
              <input inputMode="decimal" value={kuruMon} onChange={(e) => setKuruMon(e.target.value)} placeholder="1" />
            </label>
            <button className="cta ghost" disabled={busy} onClick={fundFromKuru}>
              Swap &amp; deposit
            </button>
          </div>
          {kuruStep && <p className="muted small">{STEP_LABEL[kuruStep]}</p>}
          {kuruErr && <p className={kuruErr.startsWith("Received") ? "ok" : "warn"}>{kuruErr}</p>}
        </>
      )}

      {CHAIN_ID !== 31337 && (
        <>
          <div className="fields" style={{ gridTemplateColumns: "1fr auto" }}>
            <label>
              Fund from any chain (Aurora)
              <select value={auroraChain} onChange={(e) => setAuroraChain(e.target.value as SourceChainId)}>
                {SOURCE_CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="cta ghost" disabled={busy} onClick={requestAuroraAddress}>
              Get address
            </button>
          </div>
          {auroraAddress && (
            <p className="ok small">
              Send USDC (or another supported asset) from {SOURCE_CHAINS.find((c) => c.id === auroraChain)?.label} to{" "}
              <code>{auroraAddress}</code>. It arrives here as USDC — then use Deposit above.
            </p>
          )}
          {auroraErr && <p className="warn">{auroraErr}</p>}
        </>
      )}

      <p className="muted small">
        Testnet only. Test funds and prices have no real value.
      </p>
    </section>
  );
}
