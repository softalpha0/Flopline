import { useEffect, useState } from "react";
import type { Address } from "viem";
import { equityVault, publicClient } from "./chain";

export type Stream = {
  id: bigint;
  token: Address;
  seller: Address;
  buyer: Address;
  amount: bigint;
  claimed: bigint;
  vestStart: number;
  vestEnd: number;
  askPrice: bigint; // 0 once sold or cancelled
  claimable: bigint;
};

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export function useStreams() {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const count = (await publicClient.readContract({ ...equityVault, functionName: "streamCount" })) as bigint;
        const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
        const rows = await Promise.all(
          ids.map(async (id) => {
            const s = (await publicClient.readContract({ ...equityVault, functionName: "streams", args: [id] })) as readonly [
              Address, Address, Address, bigint, bigint, bigint, bigint, bigint,
            ];
            const claimable =
              s[2] === ZERO
                ? 0n
                : ((await publicClient.readContract({ ...equityVault, functionName: "claimable", args: [id] })) as bigint);
            return {
              id,
              token: s[0],
              seller: s[1],
              buyer: s[2],
              amount: s[3],
              claimed: s[4],
              vestStart: Number(s[5]),
              vestEnd: Number(s[6]),
              askPrice: s[7],
              claimable,
            };
          }),
        );
        if (!stopped) {
          setStreams(rows.filter((r) => r.amount > 0n || r.claimed > 0n)); // skip cancelled/deleted
          setNow(Math.floor(Date.now() / 1000));
        }
      } catch {
        /* transient RPC error: keep last known streams */
      }
    };
    load();
    const id = setInterval(load, 3000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [refresh]);

  return { streams, now, refresh: () => setRefresh((n) => n + 1) };
}
