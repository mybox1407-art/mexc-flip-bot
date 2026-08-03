import crypto from "node:crypto";
import { config } from "../config.js";
import type { FlipSignal, MexcTicker } from "../types.js";
import type { DexPair } from "../mexc/dexscreener.js";

interface DexSnapshot extends DexPair {
  updatedAt: number;
}

interface SymbolState {
  dexHistory: Array<{ price: number; ts: number }>;
  lastDirection?: "LONG" | "SHORT";
  confirmCount: number;
  cooldownUntil: number;
  lastSignalAt: number;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class SpreadEngine {
  private readonly dexSnapshots = new Map<string, DexSnapshot>();
  private readonly states = new Map<string, SymbolState>();

  updateDexPrice(symbol: string, pair: DexPair): void {
    const now = Date.now();

    this.dexSnapshots.set(symbol, {
      ...pair,
      updatedAt: now
    });

    const state = this.getState(symbol);
    state.dexHistory.push({ price: pair.priceUsd, ts: now });

    const cutoff = now - 30_000;
    state.dexHistory = state.dexHistory.filter((point) => point.ts >= cutoff);
  }

  evaluate(ticker: MexcTicker): FlipSignal | null {
    const anchor = this.dexSnapshots.get(ticker.symbol);
    if (!anchor) {
      return null;
    }

    const now = Date.now();
    const state = this.getState(ticker.symbol);
    const anchorAgeMs = now - anchor.updatedAt;

    if (anchorAgeMs > config.maxDexAnchorAgeMs) {
      return null;
    }

    if (anchor.liquidityUsd < config.dexMinLiquidityUsd) {
      return null;
    }

    if (anchor.volumeM5 < config.dexMinVolumeM5Usd) {
      return null;
    }

    if (ticker.amount24 < config.minMexcTurnover24h) {
      return null;
    }

    const mexcBid = ticker.maxBidPrice;
    const mexcAsk = ticker.minAskPrice;

    if (!Number.isFinite(mexcBid) || !Number.isFinite(mexcAsk) || mexcBid <= 0 || mexcAsk <= 0) {
      return null;
    }

    if (mexcAsk <= mexcBid) {
      return null;
    }

    const mexcMid = (mexcBid + mexcAsk) / 2;
    const mexcBookSpreadPct = ((mexcAsk - mexcBid) / mexcMid) * 100;

    if (mexcBookSpreadPct > config.maxMexcBookSpreadPct) {
      return null;
    }

    const dexDriftPct = this.calculateDexDriftPct(state.dexHistory);
    if (dexDriftPct > config.maxDexDriftPct) {
      return null;
    }

    const longSpreadPct = ((anchor.priceUsd - mexcAsk) / mexcAsk) * 100;
    const shortSpreadPct = ((mexcBid - anchor.priceUsd) / mexcBid) * 100;

    let direction: "LONG" | "SHORT" | null = null;
    let spreadPct = 0;
    let mexcEntryRef = 0;
    let entryRef: "ASK" | "BID" = "ASK";
    let reason = "";

    if (longSpreadPct >= config.minSpreadPct) {
      direction = "LONG";
      spreadPct = longSpreadPct;
      mexcEntryRef = mexcAsk;
      entryRef = "ASK";
      reason = "MEXC below DEX anchor";
    } else if (shortSpreadPct >= config.minSpreadPct) {
      direction = "SHORT";
      spreadPct = shortSpreadPct;
      mexcEntryRef = mexcBid;
      entryRef = "BID";
      reason = "MEXC above DEX anchor";
    } else {
      state.lastDirection = undefined;
      state.confirmCount = 0;
      return null;
    }

    if (now < state.cooldownUntil) {
      return null;
    }

    if (state.lastDirection === direction) {
      state.confirmCount += 1;
    } else {
      state.lastDirection = direction;
      state.confirmCount = 1;
    }

    if (state.confirmCount < config.signalConfirmTicks) {
      return null;
    }

    const totalCostsPct = config.assumedFeesPct + config.assumedSlippagePct;
    const netEdgePct = spreadPct - totalCostsPct;

    if (netEdgePct < config.minNetEdgePct) {
      return null;
    }

    if (now - state.lastSignalAt < config.signalCooldownMs) {
      return null;
    }

    state.lastSignalAt = now;
    state.cooldownUntil = now + config.signalCooldownMs;

    return {
      id: crypto.randomUUID(),
      detectedAt: new Date(now).toISOString(),
      symbol: ticker.symbol,
      direction,
      spreadPct: round(spreadPct),
      netEdgePct: round(netEdgePct),
      priceDeviationPct: round(spreadPct),
      dexPrice: round(anchor.priceUsd, 6),
      mexcPrice: round(ticker.lastPrice, 6),
      mexcBid: round(mexcBid, 6),
      mexcAsk: round(mexcAsk, 6),
      mexcTurnover24h: round(ticker.amount24, 4),
      dexLiquidityUsd: round(anchor.liquidityUsd, 2),
      dexVolumeM5: round(anchor.volumeM5, 2),
      dexBuysM5: anchor.buysM5,
      dexSellsM5: anchor.sellsM5,
      dexId: anchor.dexId,
      chainId: anchor.chainId,
      quoteSymbol: anchor.quoteSymbol,
      dexPairAddress: anchor.pairAddress,
      entryRef,
      mexcBookSpreadPct: round(mexcBookSpreadPct),
      anchorAgeMs,
      dexDriftPct: round(dexDriftPct),
      confirmCount: state.confirmCount,
      reason
    };
  }

  private getState(symbol: string): SymbolState {
    let state = this.states.get(symbol);

    if (!state) {
      state = {
        dexHistory: [],
        confirmCount: 0,
        cooldownUntil: 0,
        lastSignalAt: 0
      };
      this.states.set(symbol, state);
    }

    return state;
  }

  private calculateDexDriftPct(history: Array<{ price: number; ts: number }>): number {
    if (history.length < 2) {
      return 0;
    }

    const recent = history.slice(-5);
    const prices = recent.map((item) => item.price).filter((price) => Number.isFinite(price) && price > 0);

    if (prices.length < 2) {
      return 0;
    }

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const mid = (min + max) / 2;

    if (mid <= 0) {
      return 0;
    }

    return ((max - min) / mid) * 100;
  }
}
