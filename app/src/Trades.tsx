import type { Market } from "./useExchange";
import type { RecentTrade } from "./useTrades";
import { usd } from "./format";

const timeAgo = (ts: number, now: number) => {
  const s = Math.max(0, now - ts);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
};

export function Trades({ market, trades, now }: { market: Market; trades: RecentTrade[]; now: number }) {
  return (
    <section className="card trades" aria-label="Recent trades">
      <h2>Recent trades</h2>
      {!trades.length ? (
        <p className="muted small">No fills yet in this market.</p>
      ) : (
        <div className="trade-rows">
          {trades.map((t) => (
            <div key={t.id} className="trade-row">
              <span className={t.takerBuys ? "pos" : "neg"}>{t.takerBuys ? "Buy" : "Sell"}</span>
              <span>{usd(BigInt(t.tick) * market.tickSize)}</span>
              <span className="muted">{t.qty.toString()} hrs</span>
              <span className="muted small">{timeAgo(t.timestamp, now)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
