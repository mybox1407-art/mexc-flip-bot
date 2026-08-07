import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { FlipSignal, MexcTicker } from "../types.js";
import type { DexPair } from "../mexc/dexscreener.js";
import type { DexMapper } from "./dex-mapper.js";

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

// ========== Нормализация ==========

function normalizeSymbol(value: string): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-\/\s]/g, "");
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class SpreadEngine {
  private readonly dexSnapshots = new Map<string, DexSnapshot>();
  private readonly states = new Map<string, SymbolState>();
  private readonly dexMapper: DexMapper;

  constructor(dexMapper: DexMapper) {
    this.dexMapper = dexMapper;
  }

  updateDexPrice(symbol: string, pair: DexPair): void {
    const now = Date.now();
    const normalized = normalizeSymbol(symbol);

    const mapping = this.dexMapper.get(symbol);
    const snapshotKey = mapping?.normalizedDexKey ?? normalized;

    this.dexSnapshots.set(snapshotKey, {
      ...pair,
      updatedAt: now
    });

    const state = this.getState(snapshotKey);
    state.dexHistory.push({ price: pair.priceUsd, ts: now });

    const cutoff = now - 30_000;
    state.dexHistory = state.dexHistory.filter((point) => point.ts >= cutoff);

    logger.info(
      {
        symbol,
        snapshotKey,
        price: pair.priceUsd.toFixed(6),
        liquidity: pair.liquidityUsd.toFixed(0),
        snapshotKeysCount: this.dexSnapshots.size
      },
      "DEX snapshot saved"
    );
  }

  getAnchorStatus(ticker: MexcTicker): AnchorStatus | null {
    const normalized = normalizeSymbol(ticker.symbol);
    const mapping = this.dexMapper.get(ticker.symbol);
    const snapshotKey = mapping?.normalizedDexKey ?? normalized;

    // 1. Нет active mapping
    if (!mapping || mapping.status !== "active") {
      logger.debug(
        {
          tickerSymbol: ticker.symbol,
          mappingStatus: mapping?.status,
          snapshotKey,
          mappingChainId: mapping?.chainId,
          mappingDexPairAddress: mapping?.dexPairAddress
        },
        "getAnchorStatus: no active mapping, skipping"
      );
      return null;
    }

    const anchor = this.dexSnapshots.get(snapshotKey);

    // 2. Mapping есть, но anchor snapshot отсутствует
    if (!anchor) {
      // Проверяем возраст mapping через mappedAt
      const mappingAgeMs = mapping.mappedAt
        ? Date.now() - new Date(mapping.mappedAt).getTime()
        : Infinity;

      // Если mapping свежий (< 30 секунд), считаем это нормальным и не шумим
      if (mappingAgeMs < 30_000) {
        logger.debug(
          {
            tickerSymbol: ticker.symbol,
            snapshotKey,
            mappingDexKey: mapping.normalizedDexKey,
            snapshotKeysCount: this.dexSnapshots.size,
            mappingAgeMs
          },
          "getAnchorStatus: mapped ticker has no anchor snapshot yet (mapping is fresh)"
        );
      } else {
        logger.info(
          {
            tickerSymbol: ticker.symbol,
            snapshotKey,
            mappingDexKey: mapping.normalizedDexKey,
            snapshotKeysCount: this.dexSnapshots.size,
            mappingAgeMs
          },
          "getAnchorStatus: mapped ticker has no anchor snapshot (mapping is old)"
        );
      }
      return null;
    }

    const now = Date.now();
    const anchorAgeMs = now - anchor.updatedAt;

    // ✅ ИСПРАВЛЕНО: используем bid1/ask1 вместо maxBidPrice/minAskPrice
    let mexcBid = (ticker as any).bid1;
    let mexcAsk = (ticker as any).ask1;

    // 3. Некорректные котировки MEXC
    if (!Number.isFinite(mexcBid) || !Number.isFinite(mexcAsk) || mexcBid <= 0 || mexcAsk <= 0) {
      logger.debug(
        {
          tickerSymbol: ticker.symbol,
          mexcBid,
          mexcAsk,
          lastPrice: ticker.lastPrice
        },
        "getAnchorStatus: invalid MEXC quotes, skipping"
      );
      return null;
    }

    // 4. Нормализация стакана: если ask <= bid, меняем их местами
    if (mexcAsk <= mexcBid) {
      const tmp = mexcBid;
      mexcBid = mexcAsk;
      mexcAsk = tmp;

      logger.debug(
        {
          tickerSymbol: ticker.symbol,
          mexcBid,
          mexcAsk
        },
        "getAnchorStatus: swapped bid/ask (original data had ask <= bid)"
      );
    }

    const mexcMid = (mexcBid + mexcAsk) / 2;
    const mexcBookSpreadPct = ((mexcAsk - mexcBid) / mexcMid) * 100;

    const state = this.getState(snapshotKey);
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

    // Ранний выход: нет anchor status
    if (!status) {
      logger.debug(
        {
          symbol: ticker.symbol
        },
        "evaluate(): no anchor status, skipping"
      );
      return null;
    }

    // 5. Anchor слишком старый
    if (status.anchorAgeMs > config.maxDexAnchorAgeMs) {
      logger.warn(
        {
          symbol: ticker.symbol,
          anchorAgeMs: status.anchorAgeMs,
          maxAge: config.maxDexAnchorAgeMs
        },
        "❌ DEX anchor too old"
      );
      return null;
    }

    // 6. DEX ликвидность слишком низкая
    if (status.dexLiquidityUsd < config.dexMinLiquidityUsd) {
      logger.warn(
        {
          symbol: ticker.symbol,
          liquidity: status.dexLiquidityUsd,
          minLiquidity: config.dexMinLiquidityUsd
        },
        "❌ DEX liquidity too low"
      );
      return null;
    }

    // 7. DEX объём слишком низкий
    if (status.dexVolumeM5 < config.dexMinVolumeM5Usd) {
      logger.warn(
        {
          symbol: ticker.symbol,
          volumeM5: status.dexVolumeM5,
          minVolumeM5: config.dexMinVolumeM5Usd
        },
        "❌ DEX volume too low"
      );
      return null;
    }

    // 8. MEXC turnover слишком низкий
    if (status.mexcTurnover24h < config.minMexcTurnover24h) {
      logger.warn(
        {
          symbol: ticker.symbol,
          turnover24h: status.mexcTurnover24h,
          minTurnover24h: config.minMexcTurnover24h
        },
        "❌ MEXC turnover too low"
      );
      return null;
    }

    // 9. MEXC стакан слишком широкий
    if (status.mexcBookSpreadPct > config.maxMexcBookSpreadPct) {
      logger.warn(
        {
          symbol: ticker.symbol,
          bookSpreadPct: status.mexcBookSpreadPct.toFixed(3),
          maxBookSpreadPct: config.maxMexcBookSpreadPct
        },
        "❌ MEXC book spread too wide"
      );
      return null;
    }

    // 10. DEX дрейф слишком высокий
    if (status.dexDriftPct > config.maxDexDriftPct) {
      logger.warn(
        {
          symbol: ticker.symbol,
          driftPct: status.dexDriftPct.toFixed(3),
          maxDriftPct: config.maxDexDriftPct
        },
        "❌ DEX drift too high"
      );
      return null;
    }

    const now = Date.now();
    const state = this.getState(ticker.symbol);

    // 11. Cooldown между сигналами
    if (now < state.cooldownUntil) {
      logger.warn(
        {
          symbol: ticker.symbol,
          cooldownRemaining: (state.cooldownUntil - now) / 1000
        },
        "❌ In cooldown"
      );
      return null;
    }

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
      // 12. Спред недостаточный для сигнала
      state.lastDirection = undefined;
      state.confirmCount = 0;
      logger.debug(
        {
          symbol: ticker.symbol,
          longSpreadPct: status.longSpreadPct.toFixed(3),
          shortSpreadPct: status.shortSpreadPct.toFixed(3),
          minSpreadPct: config.minSpreadPct
        },
        "evaluate(): spread below minSpreadPct, no signal"
      );
      return null;
    }

    if (state.lastDirection === direction) {
      state.confirmCount += 1;
    } else {
      state.lastDirection = direction;
      state.confirmCount = 1;
    }

    // 13. Недостаточно подтверждений
    if (state.confirmCount < config.signalConfirmTicks) {
      logger.debug(
        {
          symbol: ticker.symbol,
          confirmCount: state.confirmCount,
          required: config.signalConfirmTicks
        },
        "evaluate(): not enough confirmations"
      );
      return null;
    }

    const totalCostsPct = config.assumedFeesPct + config.assumedSlippagePct;
    const netEdgePct = spreadPct - totalCostsPct;

    // 14. Net edge слишком низкий
    if (netEdgePct < config.minNetEdgePct) {
      logger.warn(
        {
          symbol: ticker.symbol,
          spreadPct: spreadPct.toFixed(3),
          costsPct: totalCostsPct,
          netEdgePct: netEdgePct.toFixed(3),
          minNetEdge: config.minNetEdgePct
        },
        "❌ Net edge too low"
      );
      return null;
    }

    // 15. Signal cooldown
    if (now - state.lastSignalAt < config.signalCooldownMs) {
      logger.warn(
        {
          symbol: ticker.symbol,
          cooldownRemaining: (config.signalCooldownMs - (now - state.lastSignalAt)) / 1000
        },
        "❌ Signal cooldown"
      );
      return null;
    }

    state.lastSignalAt = now;
    state.cooldownUntil = now + config.signalCooldownMs;

    logger.warn(
      {
        symbol: ticker.symbol,
        direction,
        spreadPct: spreadPct.toFixed(3),
        netEdgePct: netEdgePct.toFixed(3),
        dexPrice: status.dexPrice.toFixed(6),
        mexcPrice: status.mexcLast.toFixed(6),
        mexcBid: status.mexcBid.toFixed(6),
        mexcAsk: status.mexcAsk.toFixed(6),
        reason
      },
      "🚀 SIGNAL GENERATED"
    );

    return {
      id: crypto.randomUUID(),
      detectedAt: new Date(now).toISOString(),
      symbol: ticker.symbol,
      direction,
      spreadPct: round(spreadPct),
      netEdgePct: round(netEdgePct),
      priceDeviationPct: round(spreadPct),

      currentPrice: round(status.mexcLast, 6),
      referencePrice: round(status.dexPrice, 6),
      movePct: round(spreadPct),

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
    const prices = recent
      .map((item) => item.price)
      .filter((price) => Number.isFinite(price) && price > 0);

    if (prices.length < 2) return 0;

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const mid = (min + max) / 2;

    if (mid <= 0) return 0;

    return ((max - min) / mid) * 100;
  }
}
