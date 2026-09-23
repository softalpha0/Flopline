import { useEffect, useState } from "react";
import { exchange, publicClient, setAccount, walletClient } from "./chain";
import { SignIn } from "./SignIn";
import type { Session } from "./mera";
import { Book } from "./Book";
import { Funding } from "./Funding";
import { Ticket } from "./Ticket";
import { countdown, skuName, usd } from "./format";
import { fetchMarkets, useSnapshot, type Market } from "./useExchange";
import { useRecentTrades } from "./useTrades";
import { Trades } from "./Trades";
import { useStreams } from "./useStreams";
import { EquityVault } from "./EquityVault";

export default function App() {
  const [session, setSession] = useState<Session>();
  const account = session?.account;
  const [mode, setMode] = useState<"compute" | "equity">("compute");
  const [markets, setMarkets] = useState<Market[]>([]);
  const [selected, setSelected] = useState<bigint>();
  const [pick, setPick] = useState<{ tick: number; n: number }>();
  const [claimMsg, setClaimMsg] = useState<string>();

  useEffect(() => {
    const load = () => fetchMarkets().then(setMarkets).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const market = markets.find((m) => m.id === (selected ?? markets[0]?.id));
  const { snap, refresh } = useSnapshot(market, account?.address);
  const recentTrades = useRecentTrades(market?.id);
  const streamState = useStreams();

  if (!session) {
    return (
      <SignIn
        onSession={(s) => {
          setAccount(s.account);
          setSession(s);
        }}
      />
    );
  }

  const index = snap?.index;
  const closesIn = market && snap ? countdown(market.closeTime, snap.now) : "";
  const settlesIn = market && snap ? countdown(market.settleTime, snap.now) : "";
  const closed = market && snap ? snap.now >= market.closeTime : false;
  const valueNow = snap && market ? snap.cash + snap.pos * (market.settled ? market.settlePrice : index!) : 0n;
  const hasPosition = snap ? snap.pos !== 0n || snap.cash !== 0n : false;

  async function claim() {
    try {
      const w = walletClient();
      const hash = await w.writeContract({ ...exchange, functionName: "claim", args: [market!.id] });
      await publicClient.waitForTransactionReceipt({ hash });
      setClaimMsg("Payout sent to your trading balance.");
      refresh();
    } catch (e) {
      setClaimMsg((e as { shortMessage?: string; message: string }).shortMessage ?? "Claim failed");
    }
  }

  return (
    <main className="app">
      <header className="top">
        <h1>Flopline</h1>
        <span className="who">
          <code>
            {account!.address.slice(0, 6)}...{account!.address.slice(-4)}
          </code>
          <button
            className="link"
            onClick={() => {
              session.end();
              setAccount(undefined);
              setSession(undefined);
            }}
          >
            Sign out
          </button>
        </span>
      </header>

      <div className="seg">
        <button className={mode === "compute" ? "on" : ""} onClick={() => setMode("compute")}>
          Compute
        </button>
        <button className={mode === "equity" ? "on" : ""} onClick={() => setMode("equity")}>
          Equity
        </button>
      </div>

      {mode === "compute" && (!market || !snap) && <p className="muted pad">Connecting to the exchange...</p>}

      {mode === "compute" && market && snap && (
        <>
          <nav className="tabs" aria-label="Markets">
            {markets.map((m) => (
              <button key={String(m.id)} className={m.id === market.id ? "on" : ""} onClick={() => setSelected(m.id)}>
                {skuName(m.sku).replace("H100-USEAST-", "")}
              </button>
            ))}
          </nav>

          <section className="card head">
            <div>
              <p className="muted small">{skuName(market.sku)} · 1 H100-hour</p>
              <p className="big">{index! > 0n ? usd(index!, 4) : "No index yet"}</p>
              <p className="muted small">Reference index (USDC per GPU-hour)</p>
            </div>
            <dl className="times">
              <div>
                <dt>{market.settled ? "Settled at" : closed ? "Trading closed" : "Trading closes in"}</dt>
                <dd>{market.settled ? usd(market.settlePrice, 4) : closed ? "-" : closesIn}</dd>
              </div>
              <div>
                <dt>Settlement after</dt>
                <dd>{market.settled ? "done" : settlesIn}</dd>
              </div>
            </dl>
          </section>

          <Funding free={snap.free} wallet={snap.wallet} onDone={refresh} />

          <Book market={market} bids={snap.bids} asks={snap.asks} index={index!} onPick={(tick) => setPick({ tick, n: Date.now() })} />

          <Ticket market={market} snap={snap} pick={pick} onDone={refresh} />

          <Trades market={market} trades={recentTrades} now={snap.now} />

          <section className="card">
            <h2>Your position</h2>
            {!hasPosition ? (
              <p className="muted">No position in this market yet.</p>
            ) : (
              <>
                <div className="kv">
                  <span className="muted">Net position</span>
                  <b className={snap.pos > 0n ? "pos" : snap.pos < 0n ? "neg" : ""}>
                    {snap.pos > 0n ? "Long " : snap.pos < 0n ? "Short " : "Flat "}
                    {(snap.pos < 0n ? -snap.pos : snap.pos).toString()} GPU-hrs
                  </b>
                </div>
                <div className="kv">
                  <span className="muted">{market.settled ? "Payout" : "Value at current index"}</span>
                  <b>{usd(valueNow < 0n ? 0n : valueNow)}</b>
                </div>
                <p className="muted small">
                  Value at the index now, including collateral you posted. It moves until settlement.
                </p>
              </>
            )}
            {market.settled && hasPosition && (
              <button className="cta buy" onClick={claim}>
                Claim payout
              </button>
            )}
            {claimMsg && <p className="ok">{claimMsg}</p>}
          </section>

          <footer className="muted small pad">
            Simulated market makers provide liquidity on this testnet. Prices are test values, not real GPU quotes.
          </footer>
        </>
      )}

      {mode === "equity" && (
        <EquityVault streams={streamState.streams} now={streamState.now} refresh={streamState.refresh} />
      )}
    </main>
  );
}
