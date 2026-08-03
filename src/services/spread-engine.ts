import crypto from "node:crypto";
import { config } from "../config.js";
import type { FlipSignal, MexcTicker } from "../types.js";
import type { DexPair } from "../mexc/dexscreener.js";

export interface AnchorStatus {
  symbol: string;
  dexPrice: number;
  dexLiquidityUsd: number;
  dexVolumeM5: number;
  dexBuysM5: number;
  dexSellsM5: number;
  dexId: string;
  chainId: string;
  quoteSymbol: string;
  dexPairAddress: string;
  anchorAgeMs: number;
  dexDriftPct: number;
  mexcBid: number;
  mexcAsk: number;
  mexcLast: number;
  mexcTurnover24h: number;
  mexcBookSpreadPct: number;
  longSpreadPct: number;
  shortSpreadPct: number;
}

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

  getAnchorStatus(ticker: MexcTicker): AnchorStatus | null {
    const anchor = this.dexSnapshots.get(ticker.symbol);
    if (!anchor) return null;

    const now = Date.now();
    const anchorAgeMs = now - anchor.updatedAt;

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

    const state = this.getState(ticker.symbol);
    const dexDriftPct = this.calculateDexDriftPct(state.dexHistory);

    const longSpreadPct = ((anchor.priceUsd - mexcAsk) / mexcAsk) * 100;
    const shortSpreadPct = ((mexcBid - anchor.priceUsd) / mexcBid) * 100;

    return {
      symbol: ticker.symbol,
      dexPrice: anchor.priceUsd,
      dexLiquidityUsd: anchor.liquidityUsd,
      dexVolumeM5: anchor.volumeM5,
      dexBuysM5: anchor.buysM5,
      dexSellsM5: anchor.sellsM5,
      dexId: anchor.dexId,
      chainId: anchor.chainId,
      quoteSymbol: anchor.quoteSymbol,
      dexPairAddress: anchor.pairAddress,
      anchorAgeMs,
      dexDriftPct,
      mexcBid,
      mexcAsk,
      mexcLast: ticker.lastPrice,
      mexcTurnover24h: ticker.amount24,
      mexcBookSpreadPct,
      longSpreadPct,
      shortSpreadPct
    };
  }

  evaluate(ticker: MexcTicker): FlipSignal | null {
    const status = this.getAnchorStatus(ticker);
    if (!status) return null;

    if (status.anchorAgeMs > config.maxDexAnchorAgeMs) return null;
    if (status.dexLiquidityUsd < config.dexMinLiquidityUsd) return null;
    if (status.dexVolumeM5 < config.dexMinVolumeM5Usd) return null;
    if (status.mexcTurnover24h < config.minMexcTurnover24h) return null;
    if (status.mexcBookSpreadPct > config.maxMexcBookSpreadPct) return null;
    if (status.dexDriftPct > config.maxDexDriftPct) return null;

    const now = Date.now();
    const state = this.getState(ticker.symbol);

    let direction: "LONG" | "SHORT" | null = null;
    let spreadPct = 0;
    let entryRef: "ASK" | "BID" = "ASK";
    let reason = "";

    if (status.longSpreadPct >= config.minSpreadPct) {
      direction = "LONG";
      spreadPct = status.longSpreadPct;
      entryRef = "ASK";
      reason = "MEXC below DEX anchor";
    } else if (status.shortSpreadPct >= config.minSpreadPct) {
      direction = "SHORT";
      spreadPct = status.shortSpreadPct;
      entryRef = "BID";
      reason = "MEXC above DEX anchor";
    } else {
      state.lastDirection = undefined;
      state.confirmCount = 0;
      return null;
    }

    if (now < state.cooldownUntil) return null;

    if (state.lastDirection === direction) {
      state.confirmCount += 1;
    } else {
      state.lastDirection = direction;
      state.confirmCount = 1;
    }

    if (state.confirmCount < config.signalConfirmTicks) return null;

    const totalCostsPct = config.assumedFeesPct + config.assumedSlippagePct;
    const netEdgePct = spreadPct - totalCostsPct;

    if (netEdgePct < config.minNetEdgePct) return null;
    if (now - state.lastSignalAt < config.signalCooldownMs) return null;

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
      currentPrice: round(status.mexcLast, 6),
      dexPrice: round(status.dexPrice, 6),
      mexcPrice: round(status.mexcLast, 6),
      mexcBid: round(status.mexcBid, 6),
      mexcAsk: round(status.mexcAsk, 6),
      mexcTurnover24h: round(status.mexcTurnover24h, 4),
      dexLiquidityUsd: round(status.dexLiquidityUsd, 2),
      dexVolumeM5: round(status.dexVolumeM5, 2),
      dexBuysM5: status.dexBuysM5,
      dexSellsM5: status.dexSellsM5,
      dexId: status.dexId,
      chainId: status.chainId,
      quoteSymbol: status.quoteSymbol,
      dexPairAddress: status.dexPairAddress,
      entryRef,
      mexcBookSpreadPct: round(status.mexcBookSpreadPct),
      anchorAgeMs: status.anchorAgeMs,
      dexDriftPct: round(status.dexDriftPct),
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
    if (history.length < 2) return 0;

    const recent = history.slice(-5);
    const prices = recent.map((item) => item.price).filter((price) => Number.isFinite(price) && price > 0);

    if (prices.length < 2) return 0;

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const mid = (min + max) / 2;

    if (mid <= 0) return 0;

    return ((max - min) / mid) * 100;
  }
}
