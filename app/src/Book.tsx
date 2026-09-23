import type { Level, Market } from "./useExchange";
import { usd } from "./format";

export function Book({
  market,
  bids,
  asks,
  index,
  onPick,
}: {
  market: Market;
  bids: Level[];
  asks: Level[];
  index: bigint;
  onPick: (tick: number) => void;
}) {
  const price = (t: number) => BigInt(t) * market.tickSize;
  const max = Math.max(1, ...[...bids, ...asks].map((l) => Number(l.qty)));
  const bestBid = bids[0]?.tick;
  const bestAsk = asks[0]?.tick;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : undefined;
  const rows = 6;
  const askRows = asks.slice(0, rows).reverse();

  return (
    <section className="card book" aria-label="Order book">
      <div className="book-head">
        <span>Price</span>
        <span>Size (GPU-hrs)</span>
      </div>
      {askRows.map((l) => (
        <button key={`a${l.tick}`} className="row ask" onClick={() => onPick(l.tick)}>
          <i style={{ width: `${(Number(l.qty) / max) * 100}%` }} />
          <b>{usd(price(l.tick))}</b>
          <span>{l.qty.toString()}</span>
        </button>
      ))}
      <div className="mid">
        <span>{spread !== undefined ? `Spread ${usd(price(spread))}` : "No two-sided quote"}</span>
        <span className="muted">Index {index > 0n ? usd(index, 4) : "n/a"}</span>
      </div>
      {bids.slice(0, rows).map((l) => (
        <button key={`b${l.tick}`} className="row bid" onClick={() => onPick(l.tick)}>
          <i style={{ width: `${(Number(l.qty) / max) * 100}%` }} />
          <b>{usd(price(l.tick))}</b>
          <span>{l.qty.toString()}</span>
        </button>
      ))}
      {!bids.length && !asks.length && <p className="muted pad">The book is empty. Place the first order.</p>}
    </section>
  );
}
