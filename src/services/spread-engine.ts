import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { CsvRow, MexcTicker } from "../types.js";
import type { DexPair } from "../mexc/dexscreener.js";
import { isoNow } from "../utils/time.js";

export class SpreadEngine {
  private readonly dexPrices = new Map<string, DexPair>();
  private readonly lastSignalAt = new Map<string, number>();

  updateDexPrice(mexcSymbol: string, pair: DexPair): void {
    this.dexPrices.set(mexcSymbol, pair);
  }

  evaluate(mexcTicker: MexcTicker): CsvRow | null {
    if (mexcTicker.lastPrice <= 0) {
      return null;
    }

    const dexPair = this.dexPrices.get(mexcTicker.symbol);

    if (!dexPair || dexPair.priceUsd <= 0) {
      return null;
    }

    const spreadPct =
      ((dexPair.priceUsd - mexcTicker.lastPrice) / mexcTicker.lastPrice) * 100;

    if (Math.abs(spreadPct) < config.minSpreadPct) {
      return null;
    }

    const now = Date.now();
    const prev = this.lastSignalAt.get(mexcTicker.symbol) ?? 0;

    if (now - prev < config.signalCooldownMs) {
      return null;
    }

    this.lastSignalAt.set(mexcTicker.symbol, now);

    return {
      id: randomUUID(),
      detectedAt: isoNow(),
      symbol: mexcTicker.symbol,
      direction: spreadPct > 0 ? "LONG" : "SHORT",
      spreadPct: spreadPct.toFixed(3),
      dexPrice: dexPair.priceUsd,
      mexcPrice: mexcTicker.lastPrice,
      mexcBid: mexcTicker.maxBidPrice,
      mexcAsk: mexcTicker.minAskPrice,
      mexcTurnover24h: mexcTicker.amount24,
      dexLiquidityUsd: dexPair.liquidityUsd,
      dexVolumeM5: dexPair.volumeM5,
      dexId: dexPair.dexId,
      chainId: dexPair.chainId,
      quoteSymbol: dexPair.quoteSymbol,
      dexPairAddress: dexPair.pairAddress
    };
  }
}
