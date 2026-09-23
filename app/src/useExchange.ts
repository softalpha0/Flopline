import { useEffect, useState } from "react";
import type { Address } from "viem";
import { exchange, indexC, publicClient, usdc } from "./chain";

export type Market = {
  id: bigint;
  sku: `0x${string}`;
  closeTime: number;
  settleTime: number;
  maxTick: number;
  tickSize: bigint;
  settled: boolean;
  settlePrice: bigint;
  maxMarketCollateral: bigint; // 0 = uncapped
  maxUserCollateral: bigint; // 0 = uncapped
};

export type Level = { tick: number; qty: bigint };

export type Snapshot = {
  now: number;
  bids: Level[];
  asks: Level[];
  index: bigint;
  cash: bigint;
  pos: bigint;
  free: bigint;
  wallet: bigint;
};

export async function fetchMarkets(): Promise<Market[]> {
  const count = (await publicClient.readContract({ ...exchange, functionName: "marketCount" })) as bigint;
  const out: Market[] = [];
  for (let id = 1n; id <= count; id++) {
    const m = (await publicClient.readContract({ ...exchange, functionName: "markets", args: [id] })) as readonly [
      `0x${string}`, bigint, bigint, number, bigint, boolean, bigint, bigint, bigint,
    ];
    out.push({
      id,
      sku: m[0],
      closeTime: Number(m[1]),
      settleTime: Number(m[2]),
      maxTick: Number(m[3]),
      tickSize: m[4],
      settled: m[5],
      settlePrice: m[6],
      maxMarketCollateral: m[7],
      maxUserCollateral: m[8],
    });
  }
  return out;
}

const toLevels = (r: readonly [readonly number[], readonly bigint[]]): Level[] =>
  r[0].map((tick, i) => ({ tick, qty: r[1][i] }));

export function useSnapshot(market: Market | undefined, user: Address | undefined) {
  const [snap, setSnap] = useState<Snapshot>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!market) return;
    let stopped = false;
    const load = async () => {
      try {
        const zero = "0x0000000000000000000000000000000000000000" as Address;
        const u = user ?? zero;
        const [block, asks, bids, idx, acct, free, wallet] = await Promise.all([
          publicClient.getBlock(),
          publicClient.readContract({ ...exchange, functionName: "getDepth", args: [market.id, false, 10n] }),
          publicClient.readContract({ ...exchange, functionName: "getDepth", args: [market.id, true, 10n] }),
          publicClient.readContract({ ...indexC, functionName: "latest", args: [market.sku] }),
          publicClient.readContract({ ...exchange, functionName: "accts", args: [market.id, u] }),
          publicClient.readContract({ ...exchange, functionName: "free", args: [u] }),
          publicClient.readContract({ ...usdc, functionName: "balanceOf", args: [u] }),
        ]);
        if (stopped) return;
        const a = acct as readonly bigint[];
        setSnap({
          now: Number(block.timestamp),
          asks: toLevels(asks as never),
          bids: toLevels(bids as never),
          index: (idx as readonly [bigint, bigint])[0],
          cash: a[0],
          pos: a[1],
          free: free as bigint,
          wallet: wallet as bigint,
        });
      } catch {
        /* transient RPC error: keep last snapshot */
      }
    };
    load();
    const id = setInterval(load, 700);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [market?.id, user, refresh]);

  return { snap, refresh: () => setRefresh((n) => n + 1) };
}
