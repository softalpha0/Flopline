import { useEffect, useRef, useState } from "react";
import { parseAbiItem } from "viem";
import { exchange, publicClient } from "./chain";

export type RecentTrade = {
  id: string; // blockNumber-logIndex
  tick: number;
  qty: bigint;
  takerBuys: boolean;
  blockNumber: bigint;
  timestamp: number;
};

const TRADE_EVENT = parseAbiItem(
  "event Trade(uint256 indexed marketId, uint64 indexed makerOrderId, address maker, address taker, bool takerBuys, uint32 tick, uint64 qty)",
);

const LOOKBACK_BLOCKS = 5000n; // bounded initial window; incremental after that
const LIMIT = 25;
const POLL_MS = 2000;

/// Recent fills for a market, read straight from Trade logs. Stands in for the Envio indexer
/// until that's validated; swap this hook out once /trades is backed by HyperIndex.
export function useRecentTrades(marketId: bigint | undefined) {
  const [trades, setTrades] = useState<RecentTrade[]>([]);
  const lastBlock = useRef<bigint | undefined>(undefined);
  const blockTime = useRef(new Map<bigint, number>());

  useEffect(() => {
    setTrades([]);
    lastBlock.current = undefined;
    blockTime.current = new Map();
    if (marketId === undefined) return;

    let stopped = false;

    const timestampOf = async (bn: bigint) => {
      const cached = blockTime.current.get(bn);
      if (cached !== undefined) return cached;
      const b = await publicClient.getBlock({ blockNumber: bn });
      blockTime.current.set(bn, Number(b.timestamp));
      return Number(b.timestamp);
    };

    const poll = async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const fromBlock =
          lastBlock.current !== undefined ? lastBlock.current + 1n : latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
        if (fromBlock > latest) return;

        const logs = await publicClient.getLogs({
          address: exchange.address,
          event: TRADE_EVENT,
          args: { marketId },
          fromBlock,
          toBlock: latest,
        });
        lastBlock.current = latest;
        if (!logs.length || stopped) return;

        const fresh: RecentTrade[] = await Promise.all(
          logs.map(async (l) => ({
            id: `${l.blockNumber}-${l.logIndex}`,
            tick: Number(l.args.tick),
            qty: l.args.qty as bigint,
            takerBuys: l.args.takerBuys as boolean,
            blockNumber: l.blockNumber as bigint,
            timestamp: await timestampOf(l.blockNumber as bigint),
          })),
        );
        if (stopped) return;
        setTrades((prev) => [...fresh].reverse().concat(prev).slice(0, LIMIT));
      } catch {
        /* transient RPC error: keep last known trades */
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [marketId]);

  return trades;
}
