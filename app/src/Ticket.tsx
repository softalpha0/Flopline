import { useEffect, useMemo, useState } from "react";
import { parseEventLogs, type Abi } from "viem";
import { exchange, publicClient, walletClient, getAccount } from "./chain";
import type { Level, Market, Snapshot } from "./useExchange";
import { usd } from "./format";

function eventArgs<T>(logs: readonly unknown[], eventName: string): T[] {
  return (parseEventLogs({ abi: exchange.abi as Abi, logs: logs as never, eventName }) as unknown as { args: T }[]).map((l) => l.args);
}

type Props = { market: Market; snap: Snapshot; pick?: { tick: number; n: number }; onDone: () => void };

export function Ticket({ market, snap, pick, onDone }: Props) {
  const tickUsd = Number(market.tickSize) / 1e6;
  const maxUnits = BigInt(market.maxTick) * market.tickSize;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [mode, setMode] = useState<"now" | "rest">("now");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("10");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const bestAsk = snap.asks[0]?.tick;
  const bestBid = snap.bids[0]?.tick;

  useEffect(() => {
    if (pick) setPrice((pick.tick * tickUsd).toFixed(2));
  }, [pick?.n]);

  useEffect(() => {
    if (price === "") {
      const t = side === "buy" ? bestAsk : bestBid;
      if (t) setPrice((t * tickUsd).toFixed(2));
    }
  }, [side, bestAsk, bestBid]);

  const tick = Math.round(parseFloat(price || "0") / tickUsd);
  const q = /^\d+$/.test(qty) ? BigInt(qty) : 0n;
  const validTick = tick >= 1 && tick < market.maxTick;
  const closed = snap.now >= market.closeTime;

  const preview = useMemo(() => {
    const levels: Level[] = side === "buy" ? snap.asks : snap.bids;
    let left = q;
    let filled = 0n;
    let cost = 0n;
    if (mode === "now") {
      for (const l of levels) {
        const ok = side === "buy" ? l.tick <= tick : l.tick >= tick;
        if (!ok || left === 0n) break;
        const take = left < l.qty ? left : l.qty;
        filled += take;
        cost += take * BigInt(l.tick) * market.tickSize;
        left -= take;
      }
    }
    return { filled, avg: filled > 0n ? cost / filled : 0n };
  }, [side, mode, tick, q, snap.asks, snap.bids]);

  const limitUnits = BigInt(Math.max(tick, 0)) * market.tickSize;
  const notional = limitUnits * q;
  const lockUnits = side === "buy" ? notional : (maxUnits - limitUnits) * q;
  const gainUnits = side === "buy" ? (maxUnits - limitUnits) * q : notional;
  const lossUnits = lockUnits;
  const short = lockUnits > snap.free + (snap.cash > 0n ? snap.cash : 0n);

  async function submit() {
    setBusy(true);
    setMsg(undefined);
    try {
      const w = walletClient();
      const hash = await w.writeContract({
        ...exchange,
        functionName: "placeOrder",
        args: [market.id, side === "buy", tick, q, mode === "now"],
      });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      const trades = eventArgs<{ taker: string; qty: bigint }>(r.logs, "Trade");
      const me = getAccount().address.toLowerCase();
      const mine = trades.filter((t) => t.taker.toLowerCase() === me);
      const filled = mine.reduce((s, t) => s + t.qty, 0n);
      const rested = eventArgs<{ qty: bigint }>(r.logs, "OrderPlaced");
      setMsg({
        ok: true,
        text:
          `${filled > 0n ? `Filled ${filled} of ${q}` : "No fill"}` +
          (rested.length ? `; ${rested[0].qty} resting on the book` : "") +
          (mode === "now" && filled < q ? "; the rest was cancelled" : ""),
      });
      onDone();
    } catch (e) {
      const err = e as { shortMessage?: string; message: string };
      setMsg({ ok: false, text: err.shortMessage ?? err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ticket" aria-label="Order ticket">
      <div className="seg" role="tablist">
        <button className={side === "buy" ? "on buy" : ""} onClick={() => setSide("buy")}>
          Buy (hedge cost)
        </button>
        <button className={side === "sell" ? "on sell" : ""} onClick={() => setSide("sell")}>
          Sell (lock price)
        </button>
      </div>

      <div className="fields">
        <label>
          Limit price per GPU-hour
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="2.50" />
        </label>
        <label>
          Quantity (GPU-hours)
          <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="10" />
        </label>
      </div>

      <div className="seg small">
        <button className={mode === "now" ? "on" : ""} onClick={() => setMode("now")}>
          Fill now
        </button>
        <button className={mode === "rest" ? "on" : ""} onClick={() => setMode("rest")}>
          Rest on book
        </button>
      </div>

      <dl className="facts">
        {mode === "now" && (
          <div>
            <dt>Expected fill</dt>
            <dd>
              {preview.filled.toString()} of {q.toString()}
              {preview.filled > 0n && ` at avg ${usd(preview.avg)}`}
            </dd>
          </div>
        )}
        <div>
          <dt>Collateral locked</dt>
          <dd>{usd(lockUnits)}</dd>
        </div>
        <div>
          <dt>Break-even settlement</dt>
          <dd>{validTick ? usd(limitUnits) : "n/a"}</dd>
        </div>
        <div>
          <dt>Best case / worst case</dt>
          <dd>
            <span className="pos">+{usd(gainUnits)}</span> / <span className="neg">-{usd(lossUnits)}</span>
          </dd>
        </div>
      </dl>

      <p className="risk">
        Cash-settled. At expiry each contract pays the settlement index (between $0.00 and {usd(maxUnits)}) per GPU-hour
        to the buyer and the remainder to the seller. No GPUs are delivered. You can lose all collateral locked.
      </p>

      {short && <p className="warn">Not enough collateral. Add test funds above.</p>}
      {closed && <p className="warn">Trading is closed for this market.</p>}

      <button className={`cta ${side}`} disabled={busy || !validTick || q === 0n || closed} onClick={submit}>
        {busy ? "Confirming..." : `${side === "buy" ? "Buy" : "Sell"} ${q.toString()} @ ${validTick ? usd(limitUnits) : "?"}`}
      </button>
      {msg && <p className={msg.ok ? "ok" : "warn"}>{msg.text}</p>}
    </section>
  );
}
