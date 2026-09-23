import { useState } from "react";
import { equityVault, getAccount, mockEquity, publicClient, usdc, walletClient } from "./chain";
import { ensureGas } from "./gas";
import { usd } from "./format";
import type { Stream } from "./useStreams";

const fmtShares = (v: bigint) => (Number(v) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtDate = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="progress">
      <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

export function EquityVault({ streams, now, refresh }: { streams: Stream[]; now: number; refresh: () => void }) {
  const account = getAccount();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const [amount, setAmount] = useState("50");
  const [days, setDays] = useState("180");
  const [price, setPrice] = useState("2000");

  const open = streams.filter((s) => s.askPrice > 0n);
  const mine = streams.filter((s) => s.seller.toLowerCase() === account.address.toLowerCase() && s.askPrice > 0n);
  const owned = streams.filter((s) => s.buyer.toLowerCase() === account.address.toLowerCase());

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setMsg(undefined);
    try {
      await ensureGas(account.address);
      await fn();
      refresh();
      setMsg({ ok: true, text: label });
    } catch (e) {
      const x = e as { shortMessage?: string; message: string };
      setMsg({ ok: false, text: x.shortMessage ?? x.message });
    } finally {
      setBusy(false);
    }
  }

  const confirmTx = async (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });

  async function getShares() {
    await run("Received 100 mNVDA (test shares).", async () => {
      const w = walletClient();
      await confirmTx(await w.writeContract({ ...mockEquity, functionName: "faucet" }));
    });
  }

  async function getWalletUsdc() {
    await run("Received 10,000 test USDC in your wallet.", async () => {
      const w = walletClient();
      await confirmTx(await w.writeContract({ ...usdc, functionName: "faucet" }));
    });
  }

  async function list() {
    const amt = BigInt(Math.round(parseFloat(amount || "0") * 1e18));
    const dur = BigInt(Math.round(parseFloat(days || "0") * 86400));
    const ask = BigInt(Math.round(parseFloat(price || "0") * 1e6));
    if (amt === 0n || dur === 0n || ask === 0n) return;
    await run("Listed for sale.", async () => {
      const w = walletClient();
      await confirmTx(await w.writeContract({ ...mockEquity, functionName: "approve", args: [equityVault.address, amt] }));
      const start = BigInt(Math.floor(Date.now() / 1000));
      await confirmTx(
        await w.writeContract({ ...equityVault, functionName: "list", args: [mockEquity.address, amt, start, start + dur, ask] }),
      );
    });
  }

  async function cancel(id: bigint) {
    await run("Listing cancelled, shares returned.", async () => {
      const w = walletClient();
      await confirmTx(await w.writeContract({ ...equityVault, functionName: "cancel", args: [id] }));
    });
  }

  async function buy(s: Stream) {
    await run("Bought — equity streams to you as it vests.", async () => {
      const w = walletClient();
      await confirmTx(await w.writeContract({ ...usdc, functionName: "approve", args: [equityVault.address, s.askPrice] }));
      await confirmTx(await w.writeContract({ ...equityVault, functionName: "buy", args: [s.id] }));
    });
  }

  async function claim(id: bigint) {
    await run("Claimed vested shares.", async () => {
      const w = walletClient();
      await confirmTx(await w.writeContract({ ...equityVault, functionName: "claim", args: [id] }));
    });
  }

  return (
    <>
      <section className="card">
        <h2>Sell vesting equity for cash today</h2>
        <p className="muted small">
          Lock a tokenized equity grant and sell it now. The buyer pays upfront; the shares stream to them
          automatically as they vest — the actual token moves over time, this isn't a cash-settled bet on the price.
        </p>
        <div className="row-buttons">
          <button className="cta ghost" disabled={busy} onClick={getShares}>
            Get 100 test mNVDA shares
          </button>
          <button className="cta ghost" disabled={busy} onClick={getWalletUsdc}>
            Get test USDC (to buy)
          </button>
        </div>
      </section>

      <section className="card">
        <h2>List a stream</h2>
        <div className="fields">
          <label>
            Shares (mNVDA)
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            Vests over (days)
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
        </div>
        <label>
          Ask price (USDC, paid upfront)
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <button className="cta buy" disabled={busy} onClick={list}>
          List for sale
        </button>
      </section>

      <section className="card">
        <h2>Marketplace</h2>
        {!open.length ? (
          <p className="muted small">No streams for sale yet.</p>
        ) : (
          open.map((s) => (
            <div key={s.id.toString()} className="stream-row">
              <div>
                <b>{fmtShares(s.amount)} mNVDA</b>
                <p className="muted small">
                  Vests {fmtDate(s.vestStart)} → {fmtDate(s.vestEnd)}
                </p>
              </div>
              <div className="stream-price">
                <b>{usd(s.askPrice)}</b>
                <button className="cta ghost" disabled={busy} onClick={() => buy(s)}>
                  Buy
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      {mine.length > 0 && (
        <section className="card">
          <h2>Your listings</h2>
          {mine.map((s) => (
            <div key={s.id.toString()} className="stream-row">
              <div>
                <b>{fmtShares(s.amount)} mNVDA</b>
                <p className="muted small">Asking {usd(s.askPrice)}</p>
              </div>
              <button className="cta ghost" disabled={busy} onClick={() => cancel(s.id)}>
                Cancel
              </button>
            </div>
          ))}
        </section>
      )}

      {owned.length > 0 && (
        <section className="card">
          <h2>Your streams</h2>
          {owned.map((s) => {
            const pct = ((Math.min(now, s.vestEnd) - s.vestStart) / (s.vestEnd - s.vestStart)) * 100;
            return (
              <div key={s.id.toString()} className="stream-row column">
                <div className="stream-row">
                  <div>
                    <b>{fmtShares(s.amount)} mNVDA</b>
                    <p className="muted small">{fmtShares(s.claimed)} claimed so far</p>
                  </div>
                  <button className="cta buy" disabled={busy || s.claimable === 0n} onClick={() => claim(s.id)}>
                    Claim {s.claimable > 0n ? fmtShares(s.claimable) : ""}
                  </button>
                </div>
                <ProgressBar pct={pct} />
                <p className="muted small">
                  {now >= s.vestEnd ? "Fully vested" : `Vesting until ${fmtDate(s.vestEnd)}`}
                </p>
              </div>
            );
          })}
        </section>
      )}

      {msg && <p className={msg.ok ? "ok" : "warn"}>{msg.text}</p>}
      <p className="muted small pad">
        Testnet only. mNVDA is a mock token standing in for a tokenized equity — no real NVDA exposure.
      </p>
    </>
  );
}
