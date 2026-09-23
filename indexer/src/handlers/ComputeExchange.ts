import { indexer } from "envio";

const CANDLE_SECONDS = 60n;

const skuText = (hex: string) =>
  Buffer.from(hex.replace(/^0x/, ""), "hex").toString("utf8").replace(/\0+$/, "");

indexer.onEvent({ contract: "ComputeExchange", event: "MarketCreated" }, async ({ event, context }) => {
  context.Market.set({
    id: event.params.marketId.toString(),
    sku: skuText(event.params.sku),
    closeTime: event.params.closeTime,
    settleTime: event.params.settleTime,
    maxTick: Number(event.params.maxTick),
    tickSize: event.params.tickSize,
    settled: false,
    settlePrice: undefined,
    volume: 0n,
    notional: 0n,
    tradeCount: 0,
    lastTick: undefined,
  });
});

indexer.onEvent({ contract: "ComputeExchange", event: "OrderPlaced" }, async ({ event, context }) => {
  context.Order.set({
    id: event.params.orderId.toString(),
    market_id: event.params.marketId.toString(),
    owner: event.params.owner.toLowerCase(),
    isBid: event.params.isBid,
    tick: Number(event.params.tick),
    qty: event.params.qty,
    remaining: event.params.qty,
    status: "open",
    createdAt: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({ contract: "ComputeExchange", event: "OrderCancelled" }, async ({ event, context }) => {
  const order = await context.Order.get(event.params.orderId.toString());
  if (!order) return;
  context.Order.set({ ...order, remaining: 0n, status: "cancelled" });
});

async function bumpPosition(context: any, marketId: string, user: string, delta: bigint, qty: bigint) {
  const id = `${marketId}-${user}`;
  const p = await context.Position.get(id);
  context.Position.set({
    id,
    market_id: marketId,
    user,
    net: (p?.net ?? 0n) + delta,
    volume: (p?.volume ?? 0n) + qty,
    tradeCount: (p?.tradeCount ?? 0) + 1,
    claimed: p?.claimed ?? 0n,
  });
}

indexer.onEvent({ contract: "ComputeExchange", event: "Trade" }, async ({ event, context }) => {
  const marketId = event.params.marketId.toString();
  const market = await context.Market.get(marketId);
  if (!market) return;

  const tick = Number(event.params.tick);
  const qty = event.params.qty;
  const notional = qty * BigInt(tick) * market.tickSize;
  const ts = BigInt(event.block.timestamp);

  context.Trade.set({
    id: `${event.block.number}-${event.logIndex}`,
    market_id: marketId,
    maker: event.params.maker.toLowerCase(),
    taker: event.params.taker.toLowerCase(),
    takerBuys: event.params.takerBuys,
    tick,
    qty,
    notional,
    timestamp: ts,
    blockNumber: BigInt(event.block.number),
  });

  const order = await context.Order.get(event.params.makerOrderId.toString());
  if (order) {
    const remaining = order.remaining - qty;
    context.Order.set({ ...order, remaining, status: remaining === 0n ? "filled" : "open" });
  }

  context.Market.set({
    ...market,
    volume: market.volume + qty,
    notional: market.notional + notional,
    tradeCount: market.tradeCount + 1,
    lastTick: tick,
  });

  const signed = event.params.takerBuys ? qty : -qty;
  await bumpPosition(context, marketId, event.params.taker.toLowerCase(), signed, qty);
  await bumpPosition(context, marketId, event.params.maker.toLowerCase(), -signed, qty);

  const bucket = ts - (ts % CANDLE_SECONDS);
  const candleId = `${marketId}-${bucket}`;
  const c = await context.Candle.get(candleId);
  context.Candle.set(
    c
      ? { ...c, high: Math.max(c.high, tick), low: Math.min(c.low, tick), close: tick, volume: c.volume + qty }
      : { id: candleId, market_id: marketId, bucket, open: tick, high: tick, low: tick, close: tick, volume: qty },
  );
});

indexer.onEvent({ contract: "ComputeExchange", event: "Settled" }, async ({ event, context }) => {
  const market = await context.Market.get(event.params.marketId.toString());
  if (!market) return;
  context.Market.set({ ...market, settled: true, settlePrice: event.params.price });
});

indexer.onEvent({ contract: "ComputeExchange", event: "Claimed" }, async ({ event, context }) => {
  const marketId = event.params.marketId.toString();
  const user = event.params.user.toLowerCase();
  const id = `${marketId}-${user}`;
  const p = await context.Position.get(id);
  context.Position.set({
    id,
    market_id: marketId,
    user,
    net: 0n,
    volume: p?.volume ?? 0n,
    tradeCount: p?.tradeCount ?? 0,
    claimed: (p?.claimed ?? 0n) + event.params.payout,
  });
});
