import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

import type {
  FlipSignal,
  MexcTicker
} from "../types.js";

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
  dexUpdatedAt: number;

  dexDriftPct: number;
  dexDirectionalDriftPct: number;

  // OLS-наклон DEX цены, % в минуту.
  // > 0 — DEX растёт, < 0 — падает.
  dexTrendSlopePct?: number;

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

interface PriceHistoryPoint {
  price: number;
  ts: number;
}

interface SymbolState {
  dexHistory: PriceHistoryPoint[];
  mexcHistory: PriceHistoryPoint[];

  lastMexcHistoryTs?: number;

  lastDirection?: "LONG" | "SHORT";
  confirmCount: number;
  firstConfirmAt: number;

  cooldownUntil: number;
  lastSignalAt: number;

  lastLongSignalAt: number;
  lastShortSignalAt: number;

  lastConfirmedDexUpdatedAt?: number;
}

const DEX_HISTORY_WINDOW_MS = 120_000;
const DEX_DRIFT_POINTS = 5;

const MEXC_HISTORY_WINDOW_MS = 30_000;
const MEXC_TREND_BLOCK_PCT = 0.3;

const MIN_HISTORY_POINTS = 2;

/**
 * Верхняя граница спреда для генерации сигналов (4.5%).
 * Все что выше — битый пул или чужой токен с тем же тикером.
 */
const MAX_ENTRY_SPREAD_PCT = 4.5;

function normalizeSymbol(
  value: string
): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-/\s]/g, "");
}

function round(
  value: number,
  digits = 3
): number {
  const factor = 10 ** digits;

  return (
    Math.round(value * factor) /
    factor
  );
}

function isPositiveFinite(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

function isNonNegativeFinite(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function getAnchorDeviationPct(
  dexPrice: number,
  mexcPrice: number
): number {
  if (
    !isPositiveFinite(dexPrice) ||
    !isPositiveFinite(mexcPrice)
  ) {
    return Infinity;
  }

  return (
    Math.abs(dexPrice - mexcPrice) /
    mexcPrice *
    100
  );
}

function isValidDexAnchor(
  dexPrice: number,
  mexcPrice: number
): boolean {
  const deviationPct =
    getAnchorDeviationPct(
      dexPrice,
      mexcPrice
    );

  return (
    Number.isFinite(deviationPct) &&
    deviationPct <=
      config.maxPriceDeviationPct
  );
}

export class SpreadEngine {
  private readonly dexSnapshots =
    new Map<string, DexSnapshot>();

  private readonly states =
    new Map<string, SymbolState>();

  private readonly dexMapper: DexMapper;

  constructor(
    dexMapper: DexMapper
  ) {
    this.dexMapper = dexMapper;
  }

  private getSnapshotKey(
    symbol: string
  ): string {
    return normalizeSymbol(symbol);
  }

  private getContractMultiplier(
    symbol: string
  ): number {
    const mapping =
      this.dexMapper.get(symbol);

    const multiplier =
      Number(
        mapping?.contractMultiplier ?? 1
      );

    if (
      !Number.isFinite(multiplier) ||
      multiplier <= 0
    ) {
      return 1;
    }

    return multiplier;
  }

  private normalizeDexPrice(
    symbol: string,
    rawDexPrice: number
  ): number {
    const multiplier =
      this.getContractMultiplier(symbol);

    return rawDexPrice * multiplier;
  }

  updateDexPrice(
    symbol: string,
    pair: DexPair
  ): boolean {
    const now = Date.now();

    const snapshotKey =
      this.getSnapshotKey(symbol);

    if (
      !this.isValidDexPair(pair)
    ) {
      //logger.warn(
      //  {
      //    symbol,
      //    snapshotKey,
      //    priceUsd:
      //      pair.priceUsd,
      //    liquidityUsd:
      //      pair.liquidityUsd,
      //    volumeM5:
      //      pair.volumeM5
      //  },
      //  "Invalid DEX pair snapshot, skipping"
      //);

      return false;
    }

    const contractMultiplier =
      this.getContractMultiplier(symbol);

    const normalizedDexPrice =
      this.normalizeDexPrice(
        symbol,
        pair.priceUsd
      );

    if (
      !isPositiveFinite(
        normalizedDexPrice
      )
    ) {
      //logger.warn(
      //  {
      //    symbol,
      //    snapshotKey,
      //    rawDexPrice:
      //      pair.priceUsd,
      //    contractMultiplier,
      //    normalizedDexPrice
      //  },
      //  "Invalid normalized DEX price, skipping"
      //);

      return false;
    }

    const normalizedPair: DexPair = {
      ...pair,
      priceUsd:
        normalizedDexPrice
    };

    this.dexSnapshots.set(
      snapshotKey,
      {
        ...normalizedPair,
        updatedAt: now
      }
    );

    const state =
      this.getState(snapshotKey);

    state.dexHistory.push({
      price:
        normalizedDexPrice,
      ts: now
    });

    const cutoff =
      now - DEX_HISTORY_WINDOW_MS;

    state.dexHistory =
      state.dexHistory.filter(
        (item) =>
          item.ts >= cutoff
      );

    //logger.info(
    //  {
    //    symbol,
    //    snapshotKey,

    //    rawPrice:
    //      pair.priceUsd,

    //    normalizedPrice:
    //      normalizedDexPrice,

    //    contractMultiplier,

    //    liquidity:
    //      pair.liquidityUsd.toFixed(0),

    //    volumeM5:
    //      pair.volumeM5.toFixed(0),

    //    buysM5:
    //      pair.buysM5,

    //    sellsM5:
    //      pair.sellsM5,

    //    historySize:
    //      state.dexHistory.length
    //  },
    //  "DEX snapshot saved"
    //);

    return true;
  }

  getAnchorStatus(
    ticker: MexcTicker
  ): AnchorStatus | null {
    const tickerSymbol =
      String(ticker.symbol);

    const snapshotKey =
      this.getSnapshotKey(
        tickerSymbol
      );

    const mapping =
      this.dexMapper.get(
        tickerSymbol
      );

    if (
      !mapping ||
      mapping.status !== "active"
    ) {
      //logger.debug(
      //  {
      //    tickerSymbol,
      //    mappingStatus:
      //      mapping?.status,
      //    snapshotKey
      //  },
      //  "No active DEX mapping"
      //);

      return null;
    }

    const anchor =
      this.dexSnapshots.get(
        snapshotKey
      );

    if (!anchor) {
      return null;
    }

    if (
      !this.isValidDexPair(anchor)
    ) {
      //logger.warn(
      //  {
      //    tickerSymbol,
      //    snapshotKey,
      //    priceUsd:
      //      anchor.priceUsd,
      //    liquidityUsd:
      //      anchor.liquidityUsd,
      //    volumeM5:
      //      anchor.volumeM5
      //  },
      //  "Invalid DEX snapshot"
      //);

      return null;
    }

    const now = Date.now();

    const anchorAgeMs =
      Math.max(
        0,
        now - anchor.updatedAt
      );

    const mexcBid =
      Number(ticker.bid1);

    const mexcAsk =
      Number(ticker.ask1);

    const mexcLast =
      Number(ticker.lastPrice);

    const mexcTurnover24h =
      Number(ticker.amount24);

    if (
      !isPositiveFinite(mexcBid) ||
      !isPositiveFinite(mexcAsk) ||
      !isPositiveFinite(mexcLast)
    ) {
      return null;
    }

    if (
      mexcAsk < mexcBid
    ) {
      //logger.warn(
      //  {
      //    tickerSymbol,
      //    mexcBid,
      //    mexcAsk
      //  },
      //  "Crossed MEXC book"
      //);

      return null;
    }

    const mexcMid =
      (mexcBid + mexcAsk) / 2;

    if (
      !isPositiveFinite(mexcMid)
    ) {
      return null;
    }

    const state =
      this.getState(snapshotKey);

    this.recordMexcPrice(
      state,
      mexcMid,
      ticker.timestamp,
      now
    );

    const dexDrift =
      this.calculateDexDrift(
        state.dexHistory
      );

    const dexTrendSlopePct =
      this.calculateTrendSlope(
        state.dexHistory,
        config.dexTrendWindowMs,
        config.dexTrendMinPoints
      );

    const dexPrice =
      anchor.priceUsd;

    if (
      !isValidDexAnchor(
        dexPrice,
        mexcMid
      )
    ) {
      const deviationPct =
        getAnchorDeviationPct(
          dexPrice,
          mexcMid
        );

      //logger.debug(
      //  {
      //    symbol: tickerSymbol,
      //    dexPrice,
      //    mexcMid,
      //    deviationPct,
      //    maxDeviationPct:
      //      config.maxPriceDeviationPct
      //  },
      //  "DEX anchor deviation too high"
      //);

      return null;
    }

    const mexcBookSpreadPct =
      (
        (mexcAsk - mexcBid) /
        mexcMid
      ) * 100;

    const longSpreadPct =
      (
        (dexPrice - mexcAsk) /
        mexcAsk
      ) * 100;

    const shortSpreadPct =
      (
        (mexcBid - dexPrice) /
        mexcBid
      ) * 100;

    return {
      symbol:
        tickerSymbol,

      dexPrice,

      dexLiquidityUsd:
        anchor.liquidityUsd,

      dexVolumeM5:
        anchor.volumeM5,

      dexBuysM5:
        anchor.buysM5,

      dexSellsM5:
        anchor.sellsM5,

      dexId:
        anchor.dexId,

      chainId:
        anchor.chainId,

      quoteSymbol:
        anchor.quoteSymbol,

      dexPairAddress:
        anchor.pairAddress,

      anchorAgeMs,

      dexUpdatedAt:
        anchor.updatedAt,

      dexDriftPct:
        dexDrift.rangePct,

      dexDirectionalDriftPct:
        dexDrift.directionalPct,

      dexTrendSlopePct:
        round(dexTrendSlopePct, 4),

      mexcBid,
      mexcAsk,
      mexcLast,

      mexcTurnover24h:
        isNonNegativeFinite(
          mexcTurnover24h
        )
          ? mexcTurnover24h
          : 0,

      mexcBookSpreadPct,
      longSpreadPct,
      shortSpreadPct
    };
  }

  evaluate(
    ticker: MexcTicker
  ): FlipSignal | null {
    const status =
      this.getAnchorStatus(
        ticker
      );

    if (!status) {
      return null;
    }

    const snapshotKey =
      this.getSnapshotKey(
        ticker.symbol
      );

    const state =
      this.getState(snapshotKey);

    if (
      state.dexHistory.length <
      MIN_HISTORY_POINTS
    ) {
      return null;
    }

    if (
      state.mexcHistory.length <
      MIN_HISTORY_POINTS
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    mexcHistorySize:
      //      state.mexcHistory.length,

      //    minimum:
      //      MIN_HISTORY_POINTS
      //  },
      //  "MEXC history is not ready"
      //);

      return null;
    }

    if (
      status.anchorAgeMs >
      config.maxDexAnchorAgeMs
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    anchorAgeMs:
      //      status.anchorAgeMs,

      //    maxAge:
      //      config.maxDexAnchorAgeMs
      //  },
      //  "DEX anchor is stale"
      //);

      return null;
    }

    if (
      status.dexLiquidityUsd <
      config.dexMinLiquidityUsd
    ) {
      return null;
    }

    if (
      status.dexVolumeM5 <
      config.dexMinVolumeM5Usd
    ) {
      return null;
    }

    if (
      status.dexBuysM5 <
        config.minDexBuysSellsM5 ||
      status.dexSellsM5 <
        config.minDexBuysSellsM5
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    buysM5:
      //      status.dexBuysM5,

      //    sellsM5:
      //      status.dexSellsM5,

      //    minimum:
      //      config.minDexBuysSellsM5
      //  },
      //  "DEX buys/sells activity too low"
      //);

      return null;
    }

    if (
      status.mexcTurnover24h <
      config.minMexcTurnover24h
    ) {
      return null;
    }

    if (
      status.mexcBookSpreadPct >
      config.maxMexcBookSpreadPct
    ) {
      return null;
    }

    if (
      status.dexDriftPct >
      config.maxDexDriftPct
    ) {
      return null;
    }

    const mexcDirectionalDriftPct =
      this.calculateMexcTrend(
        state.mexcHistory
      );

    const dexTrendSlopePct =
      status.dexTrendSlopePct ?? 0;

    // Входной спред должен быть в допустимом диапазоне [minSpreadPct .. MAX_ENTRY_SPREAD_PCT]
    const longValid =
      Number.isFinite(
        status.longSpreadPct
      ) &&
      status.longSpreadPct >=
        config.minSpreadPct &&
      status.longSpreadPct <=
        MAX_ENTRY_SPREAD_PCT;

    const shortValid =
      Number.isFinite(
        status.shortSpreadPct
      ) &&
      status.shortSpreadPct >=
        config.minSpreadPct &&
      status.shortSpreadPct <=
        MAX_ENTRY_SPREAD_PCT;

    if (
      !longValid &&
      !shortValid
    ) {
      state.lastDirection =
        undefined;

      state.confirmCount = 0;
      state.firstConfirmAt = 0;
      state.lastConfirmedDexUpdatedAt =
        undefined;

      return null;
    }

    /**
     * LONG запрещён, если:
     * - DEX падает (drift или OLS-тренд)
     * - MEXC падает быстрее порога.
     *
     * SHORT запрещён, если:
     * - DEX растёт (drift или OLS-тренд)
     * - MEXC растёт быстрее порога.
     */
    const longBlocked =
      status.dexDirectionalDriftPct <
        -config.maxDexDriftPct ||
      mexcDirectionalDriftPct <
        -MEXC_TREND_BLOCK_PCT ||
      dexTrendSlopePct <
        -config.dexTrendBlockPct;

    const shortBlocked =
      status.dexDirectionalDriftPct >
        config.maxDexDriftPct ||
      mexcDirectionalDriftPct >
        MEXC_TREND_BLOCK_PCT ||
      dexTrendSlopePct >
        config.dexTrendBlockPct;

    if (
      longBlocked &&
      shortBlocked
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    mexcDirectionalDriftPct,

      //    dexDirectionalDriftPct:
      //      status.dexDirectionalDriftPct,

      //    dexTrendSlopePct,

      //    longBlocked,
      //    shortBlocked
      //  },
      //  "Both directions blocked by trend filters"
      //);

      return null;
    }

    let direction:
      | "LONG"
      | "SHORT";

    let spreadPct: number;

    let entryRef:
      | "ASK"
      | "BID";

    let reason: string;

    if (
      longValid &&
      !longBlocked &&
      (
        !shortValid ||
        shortBlocked ||
        status.longSpreadPct >=
          status.shortSpreadPct
      )
    ) {
      direction = "LONG";

      spreadPct =
        status.longSpreadPct;

      entryRef = "ASK";

      reason =
        "MEXC below DEX anchor";
    } else if (
      shortValid &&
      !shortBlocked
    ) {
      direction = "SHORT";

      spreadPct =
        status.shortSpreadPct;

      entryRef = "BID";

      reason =
        "MEXC above DEX anchor";
    } else {
      return null;
    }

    //logger.debug(
    //  {
    //    symbol:
    //      ticker.symbol,

    //    direction,

    //    mexcDirectionalDriftPct,

    //    dexDirectionalDriftPct:
    //      status.dexDirectionalDriftPct,

    //    dexTrendSlopePct,

    //    longBlocked,
    //    shortBlocked,

    //    spreadPct
    //  },
    //  "MEXC trend filter"
    //);

    const directionLastSignalAt =
      direction === "LONG"
        ? state.lastLongSignalAt
        : state.lastShortSignalAt;

    if (
      nowMinus(
        directionLastSignalAt
      ) <
      config.signalCooldownMs
    ) {
      return null;
    }

    if (
      direction === "LONG" &&
      status.dexDirectionalDriftPct <
        -config.maxDexDriftPct
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    directionalDriftPct:
      //      status.dexDirectionalDriftPct
      //  },
      //  "LONG skipped: DEX anchor moving down"
      //);

      return null;
    }

    if (
      direction === "SHORT" &&
      status.dexDirectionalDriftPct >
        config.maxDexDriftPct
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    directionalDriftPct:
      //      status.dexDirectionalDriftPct
      //  },
      //  "SHORT skipped: DEX anchor moving up"
      //);

      return null;
    }

    if (
      state.lastConfirmedDexUpdatedAt ===
      status.dexUpdatedAt
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    dexUpdatedAt:
      //      status.dexUpdatedAt
      //  },
      //  "Duplicate DEX snapshot"
      //);

      return null;
    }

    state.lastConfirmedDexUpdatedAt =
      status.dexUpdatedAt;

    const signalWindowMs =
      Number(
        config.signalWindowMs ??
        5_000
      );

    const now = Date.now();

    if (
      state.lastDirection !==
      direction
    ) {
      state.lastDirection =
        direction;

      state.confirmCount = 1;
      state.firstConfirmAt = now;
    } else {
      const confirmationAge =
        now - state.firstConfirmAt;

      if (
        confirmationAge >
        signalWindowMs
      ) {
        state.confirmCount = 1;
        state.firstConfirmAt = now;
      } else {
        state.confirmCount += 1;
      }
    }

    if (
      state.confirmCount <
      config.signalConfirmTicks
    ) {
      return null;
    }

    if (
      !Number.isFinite(spreadPct) ||
      spreadPct <= 0
    ) {
      return null;
    }

    const totalCostsPct =
      config.roundTripCostPct;

    const netEdgePct =
      spreadPct -
      totalCostsPct;

    if (
      !Number.isFinite(netEdgePct) ||
      netEdgePct <
        config.minNetEdgePct
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,

      //    direction,

      //    spreadPct,

      //    totalCostsPct,

      //    netEdgePct,

      //    minNetEdge:
      //      config.minNetEdgePct
      //  },
      //  "Net edge too low"
      //);

      return null;
    }

    state.lastSignalAt =
      now;

    if (
      direction === "LONG"
    ) {
      state.lastLongSignalAt =
        now;
    } else {
      state.lastShortSignalAt =
        now;
    }

    logger.warn(
      {
        symbol:
          ticker.symbol,

        direction,

        spreadPct:
          spreadPct.toFixed(4),

        netEdgePct:
          netEdgePct.toFixed(4),

        dexPrice:
          status.dexPrice.toFixed(6),

        mexcBid:
          status.mexcBid.toFixed(6),

        mexcAsk:
          status.mexcAsk.toFixed(6),

        mexcDirectionalDriftPct:
          mexcDirectionalDriftPct.toFixed(4),

        dexDirectionalDriftPct:
          status.dexDirectionalDriftPct.toFixed(4),

        dexTrendSlopePct:
          dexTrendSlopePct.toFixed(4),

        confirmCount:
          state.confirmCount,

        reason
      },
      "SIGNAL GENERATED"
    );

    return {
      id:
        crypto.randomUUID(),

      detectedAt:
        new Date(now).toISOString(),

      symbol:
        ticker.symbol,

      direction,

      spreadPct:
        round(spreadPct),

      netEdgePct:
        round(netEdgePct),

      priceDeviationPct:
        round(spreadPct),

      currentPrice:
        round(
          status.mexcLast,
          6
        ),

      referencePrice:
        round(
          status.dexPrice,
          6
        ),

      movePct:
        round(spreadPct),

      dexPrice:
        round(
          status.dexPrice,
          6
        ),

      mexcPrice:
        round(
          status.mexcLast,
          6
        ),

      mexcBid:
        round(
          status.mexcBid,
          6
        ),

      mexcAsk:
        round(
          status.mexcAsk,
          6
        ),

      mexcTurnover24h:
        round(
          status.mexcTurnover24h,
          4
        ),

      dexLiquidityUsd:
        round(
          status.dexLiquidityUsd,
          2
        ),

      dexVolumeM5:
        round(
          status.dexVolumeM5,
          2
        ),

      dexBuysM5:
        status.dexBuysM5,

      dexSellsM5:
        status.dexSellsM5,

      dexId:
        status.dexId,

      chainId:
        status.chainId,

      quoteSymbol:
        status.quoteSymbol,

      dexPairAddress:
        status.dexPairAddress,

      entryRef,

      mexcBookSpreadPct:
        round(
          status.mexcBookSpreadPct
        ),

      anchorAgeMs:
        status.anchorAgeMs,

      dexUpdatedAt:
        status.dexUpdatedAt,

      dexDriftPct:
        round(
          status.dexDriftPct
        ),

      dexDirectionalDriftPct:
        round(
          status.dexDirectionalDriftPct
        ),

      dexTrendSlopePct:
        round(dexTrendSlopePct, 4),

      confirmCount:
        state.confirmCount,

      reason
    };
  }

  private recordMexcPrice(
    state: SymbolState,
    mexcMid: number,
    tickerTimestamp: number,
    fallbackNow: number
  ): void {
    const timestamp =
      Number.isFinite(tickerTimestamp) &&
      tickerTimestamp > 0
        ? tickerTimestamp
        : fallbackNow;

    if (
      state.lastMexcHistoryTs ===
      timestamp
    ) {
      return;
    }

    state.lastMexcHistoryTs =
      timestamp;

    state.mexcHistory.push({
      price: mexcMid,
      ts: timestamp
    });

    const cutoff =
      fallbackNow -
      MEXC_HISTORY_WINDOW_MS;

    state.mexcHistory =
      state.mexcHistory.filter(
        (item) =>
          item.ts >= cutoff
      );
  }

  private calculateMexcTrend(
    history: PriceHistoryPoint[]
  ): number {
    if (
      history.length <
      MIN_HISTORY_POINTS
    ) {
      return 0;
    }

    const first =
      history[0]?.price;

    const last =
      history[history.length - 1]?.price;

    if (
      !isPositiveFinite(first) ||
      !isPositiveFinite(last)
    ) {
      return 0;
    }

    return (
      (last - first) /
      first
    ) * 100;
  }

  /**
   * OLS-наклон цены, % в минуту.
   */
  private calculateTrendSlope(
    history: PriceHistoryPoint[],
    windowMs: number,
    minPoints: number
  ): number {
    const cutoff =
      Date.now() - windowMs;

    const points = history.filter(
      (item) =>
        item.ts >= cutoff &&
        isPositiveFinite(item.price)
    );

    if (
      points.length <
      Math.max(2, minPoints)
    ) {
      return 0;
    }

    const n = points.length;

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;

    for (const point of points) {
      sumX += point.ts;
      sumY += point.price;
      sumXY += point.ts * point.price;
      sumXX += point.ts * point.ts;
    }

    const denominator =
      n * sumXX - sumX * sumX;

    if (denominator === 0) {
      return 0;
    }

    const slopePerMs =
      (n * sumXY - sumX * sumY) /
      denominator;

    const avgPrice = sumY / n;

    if (
      !isPositiveFinite(avgPrice)
    ) {
      return 0;
    }

    return (
      (slopePerMs * 60_000) /
      avgPrice
    ) * 100;
  }

  private isValidDexPair(
    pair: DexPair
  ): boolean {
    return (
      isPositiveFinite(
        pair.priceUsd
      ) &&
      isNonNegativeFinite(
        pair.liquidityUsd
      ) &&
      isNonNegativeFinite(
        pair.volumeM5
      ) &&
      Number.isInteger(
        pair.buysM5
      ) &&
      pair.buysM5 >= 0 &&
      Number.isInteger(
        pair.sellsM5
      ) &&
      pair.sellsM5 >= 0 &&
      typeof pair.dexId ===
        "string" &&
      pair.dexId.length > 0 &&
      typeof pair.chainId ===
        "string" &&
      pair.chainId.length > 0 &&
      typeof pair.quoteSymbol ===
        "string" &&
      pair.quoteSymbol.length > 0 &&
      typeof pair.pairAddress ===
        "string" &&
      pair.pairAddress.length > 0
    );
  }

  private getState(
    symbol: string
  ): SymbolState {
    let state =
      this.states.get(symbol);

    if (!state) {
      state = {
        dexHistory: [],
        mexcHistory: [],

        lastMexcHistoryTs:
          undefined,

        confirmCount: 0,
        firstConfirmAt: 0,
        cooldownUntil: 0,
        lastSignalAt: 0,
        lastLongSignalAt: 0,
        lastShortSignalAt: 0,
        lastConfirmedDexUpdatedAt:
          undefined
      };

      this.states.set(
        symbol,
        state
      );
    }

    return state;
  }

  private calculateDexDrift(
    history: PriceHistoryPoint[]
  ): {
    rangePct: number;
    directionalPct: number;
  } {
    const cutoff =
      Date.now() -
      DEX_HISTORY_WINDOW_MS;

    const recent =
      history
        .filter(
          (item) =>
            item.ts >= cutoff &&
            isPositiveFinite(item.price)
        )
        .slice(
          -DEX_DRIFT_POINTS
        );

    if (
      recent.length <
      MIN_HISTORY_POINTS
    ) {
      return {
        rangePct: 0,
        directionalPct: 0
      };
    }

    const prices =
      recent.map(
        (item) => item.price
      );

    const min =
      Math.min(...prices);

    const max =
      Math.max(...prices);

    const first =
      prices[0];

    const last =
      prices[prices.length - 1];

    const mid =
      (min + max) / 2;

    if (
      !isPositiveFinite(mid) ||
      !isPositiveFinite(first) ||
      !isPositiveFinite(last)
    ) {
      return {
        rangePct: 0,
        directionalPct: 0
      };
    }

    return {
      rangePct:
        ((max - min) / mid) *
        100,

      directionalPct:
        ((last - first) / first) *
        100
    };
  }
}

function nowMinus(
  timestamp: number
): number {
  return Date.now() - timestamp;
}
