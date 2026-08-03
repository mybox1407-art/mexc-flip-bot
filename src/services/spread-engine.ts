import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { CsvRow, MexcTicker } from "../types.js";
import type { DexPair } from "../mexc/dexscreener.js";
import { isoNow } from "../utils/time.js";

function normalizeSymbol(value: string): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-\/\s]/g, "");
}

function looksSuspiciousSymbol(mexcSymbol: string): boolean {
  const base = mexcSymbol.split("_")[0]?.toUpperCase() ?? mexcSymbol.toUpperCase();

  if (/\d{3,}/.test(base)) {
    return true;
  }

  const blockedFragments = [
    "USD1",
    "STOCK",
    "TESLA",
    "NVIDIA",
    "SPACEX",
    "MICRO",
    "APPLE"
  ];

  return blockedFragments.some((fragment) => base.includes(fragment));
}

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

    if (mexcTicker.amount24 < config.minMexcTurnover24h) {
      return null;
    }

    if (looksSuspiciousSymbol(mexcTicker.symbol)) {
      return null;
    }

    const dexPair = this.dexPrices.get(mexcTicker.symbol);

    if (!dexPair || dexPair.priceUsd <= 0) {
      return null;
    }

    const baseSymbol = mexcTicker.symbol.split("_")[0] ?? mexcTicker.symbol;
    const normalizedMexcBase = normalizeSymbol(baseSymbol);
    const normalizedDexBase = normalizeSymbol(dexPair.baseSymbol);

    if (normalizedMexcBase !== normalizedDexBase) {
      return null;
    }

    const totalDexTxnsM5 = dexPair.buysM5 + dexPair.sellsM5;

    if (totalDexTxnsM5 < config.minDexBuysSellsM5) {
      return null;
    }

    const priceDeviationPct =
      (Math.abs(dexPair.priceUsd - mexcTicker.lastPrice) / mexcTicker.lastPrice) * 100;

    if (priceDeviationPct > config.maxPriceDeviationPct) {
      return null;
    }

    const spreadPct =
      ((dexPair.priceUsd - mexcTicker.lastPrice) / mexcTicker.lastPrice) * 100;

    if (Math.abs(spreadPct) < config.minSpreadPct) {
      return null;
    }

    const netEdgePct = Math.abs(spreadPct) - config.roundTripCostPct;

    if (netEdgePct < config.minNetEdgePct) {
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
      netEdgePct: netEdgePct.toFixed(3),
      priceDeviationPct: priceDeviationPct.toFixed(3),
      dexPrice: dexPair.priceUsd,
      mexcPrice: mexcTicker.lastPrice,
      mexcBid: mexcTicker.maxBidPrice,
      mexcAsk: mexcTicker.minAskPrice,
      mexcTurnover24h: mexcTicker.amount24,
      dexLiquidityUsd: dexPair.liquidityUsd,
      dexVolumeM5: dexPair.volumeM5,
      dexBuysM5: dexPair.buysM5,
      dexSellsM5: dexPair.sellsM5,
      dexId: dexPair.dexId,
      chainId: dexPair.chainId,
      quoteSymbol: dexPair.quoteSymbol,
      dexPairAddress: dexPair.pairAddress
    };
  }
}
