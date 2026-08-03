import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { FlipSignal, MexcTicker } from "../types.js";
import { isoNow } from "../utils/time.js";
import { MarketCache } from "./market-cache.js";

export class SignalEngine {
  private readonly lastSignalAt = new Map<string, number>();

  constructor(private readonly marketCache: MarketCache) {}

  evaluate(ticker: MexcTicker): FlipSignal | null {
    const referencePrice = this.marketCache.getReferencePrice(ticker.symbol);

    if (!referencePrice || referencePrice <= 0 || ticker.lastPrice <= 0) {
      return null;
    }

    if (ticker.amount24 < config.signalMinTurnoverUsdt) {
      return null;
    }

    const movePct = ((ticker.lastPrice - referencePrice) / referencePrice) * 100;

    if (Math.abs(movePct) < config.signalMinMovePct) {
      return null;
    }

    const now = Date.now();
    const previousSignalAt = this.lastSignalAt.get(ticker.symbol) ?? 0;

    if (now - previousSignalAt < config.signalWindowMs) {
      return null;
    }

    this.lastSignalAt.set(ticker.symbol, now);

    const bid = ticker.maxBidPrice;
    const ask = ticker.minAskPrice;
    const spreadPct =
      bid > 0 && ask > 0 ? ((ask - bid) / bid) * 100 : 0;

    return {
      id: randomUUID(),
      symbol: ticker.symbol,
      direction: movePct > 0 ? "LONG" : "SHORT",
      detectedAt: isoNow(),
      currentPrice: ticker.lastPrice,
      referencePrice,
      movePct,
      mexcTurnover24h: ticker.amount24,
      mexcBid: bid,
      mexcAsk: ask,
      mexcPrice: ticker.lastPrice,
      spreadPct,
      mexcBookSpreadPct: spreadPct,
      netEdgePct: 0,
      priceDeviationPct: movePct,
      dexPrice: 0,
      dexLiquidityUsd: 0,
      dexVolumeM5: 0,
      dexBuysM5: 0,
      dexSellsM5: 0,
      dexId: "",
      chainId: "",
      quoteSymbol: "USDT",
      dexPairAddress: "",
      entryRef: movePct > 0 ? "ASK" : "BID",
      anchorAgeMs: 0,
      dexDriftPct: 0,
      confirmCount: 1,
      reason: `Price moved ${movePct.toFixed(2)}% over ${config.signalWindowMs / 1000}s`,
    };
  }
}
