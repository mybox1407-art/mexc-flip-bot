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
  dexHistory: Array<{
    price: number;
    ts: number;
  }>;

  lastDirection?: "LONG" | "SHORT";
  confirmCount: number;
  firstConfirmAt: number;
  cooldownUntil: number;
  lastSignalAt: number;
  lastConfirmedDexUpdatedAt?: number;
}

const DEX_ANCHOR_MAX_RATIO = 2;
const DEX_HISTORY_WINDOW_MS = 120_000;
const DEX_DRIFT_POINTS = 5;
const SIGNAL_CONFIRM_WINDOW_MS = 5_000;
const MIN_DEX_HISTORY_POINTS = 2;

function normalizeSymbol(value: string): string {
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
  return Math.round(value * factor) / factor;
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

function isValidDexAnchor(
  dexPrice: number,
  mexcPrice: number
): boolean {
  if (
    !isPositiveFinite(dexPrice) ||
    !isPositiveFinite(mexcPrice)
  ) {
    return false;
  }

  const ratio =
    Math.max(dexPrice, mexcPrice) /
    Math.min(dexPrice, mexcPrice);

  return ratio <= DEX_ANCHOR_MAX_RATIO;
}

export class SpreadEngine {
  private readonly dexSnapshots =
    new Map<string, DexSnapshot>();

  private readonly states =
    new Map<string, SymbolState>();

  private readonly dexMapper: DexMapper;

  constructor(dexMapper: DexMapper) {
    this.dexMapper = dexMapper;
  }

  private getSnapshotKey(
    symbol: string
  ): string {
    const normalized = normalizeSymbol(symbol);
    const mapping = this.dexMapper.get(symbol);

    return (
      mapping?.normalizedDexKey ??
      normalized
    );
  }

  updateDexPrice(
    symbol: string,
    pair: DexPair
  ): void {
    const now = Date.now();
    const snapshotKey =
      this.getSnapshotKey(symbol);

    if (!this.isValidDexPair(pair)) {
      logger.warn(
        {
          symbol,
          snapshotKey,
          priceUsd: pair.priceUsd,
          liquidityUsd: pair.liquidityUsd,
          volumeM5: pair.volumeM5
        },
        "Invalid DEX pair snapshot, skipping"
      );

      return;
    }

    this.dexSnapshots.set(snapshotKey, {
      ...pair,
      updatedAt: now
    });

    const state =
      this.getState(snapshotKey);

    state.dexHistory.push({
      price: pair.priceUsd,
      ts: now
    });

    const cutoff =
      now - DEX_HISTORY_WINDOW_MS;

    state.dexHistory =
      state.dexHistory.filter(
        (point) => point.ts >= cutoff
      );

    logger.info(
      {
        symbol,
        snapshotKey,
        price: pair.priceUsd.toFixed(6),
        liquidity:
          pair.liquidityUsd.toFixed(0),
        volumeM5:
          pair.volumeM5.toFixed(0),
        historySize:
          state.dexHistory.length
      },
      "DEX snapshot saved"
    );
  }

  getAnchorStatus(
    ticker: MexcTicker
  ): AnchorStatus | null {
    const tickerSymbol =
      String(ticker.symbol);

    const snapshotKey =
      this.getSnapshotKey(tickerSymbol);

    const mapping =
      this.dexMapper.get(tickerSymbol);

    if (
      !mapping ||
      mapping.status !== "active"
    ) {
      return null;
    }

    const anchor =
      this.dexSnapshots.get(snapshotKey);

    if (!anchor) {
      return null;
    }

    if (!this.isValidDexPair(anchor)) {
      return null;
    }

    const now = Date.now();

    const anchorAgeMs = Math.max(
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

    if (mexcAsk < mexcBid) {
      return null;
    }

    const mexcMid =
      (mexcBid + mexcAsk) / 2;

    if (!isPositiveFinite(mexcMid)) {
      return null;
    }

    const state =
      this.getState(snapshotKey);

    const drift =
      this.calculateDexDrift(
        state.dexHistory
      );

    const dexPrice =
      anchor.priceUsd;

    if (
      !isValidDexAnchor(
        dexPrice,
        mexcMid
      )
    ) {
      return null;
    }

    const mexcBookSpreadPct =
      ((mexcAsk - mexcBid) /
        mexcMid) *
      100;

    const longSpreadPct =
      ((dexPrice - mexcAsk) /
        mexcAsk) *
      100;

    const shortSpreadPct =
      ((mexcBid - dexPrice) /
        mexcBid) *
      100;

    return {
      symbol: tickerSymbol,
      dexPrice,
      dexLiquidityUsd:
        anchor.liquidityUsd,
      dexVolumeM5:
        anchor.volumeM5,
      dexBuysM5:
        anchor.buysM5,
      dexSellsM5:
        anchor.sellsM5,
      dexId: anchor.dexId,
      chainId: anchor.chainId,
      quoteSymbol: anchor.quoteSymbol,
      dexPairAddress: anchor.pairAddress,

      anchorAgeMs,
      dexUpdatedAt: anchor.updatedAt,

      dexDriftPct: drift.rangePct,
      dexDirectionalDriftPct:
        drift.directionalPct,

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
      this.getAnchorStatus(ticker);

    if (!status) {
      return null;
    }

    const snapshotKey =
      this.getSnapshotKey(ticker.symbol);

    const state =
      this.getState(snapshotKey);

    if (
      state.dexHistory.length <
      MIN_DEX_HISTORY_POINTS
    ) {
      return null;
    }

    if (
      status.anchorAgeMs >
      config.maxDexAnchorAgeMs
    ) {
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

    const now = Date.now();

    if (
      now < state.cooldownUntil
    ) {
      return null;
    }

    const longValid =
      status.longSpreadPct >=
      config.minSpreadPct;

    const shortValid =
      status.shortSpreadPct >=
      config.minSpreadPct;

    if (!longValid && !shortValid) {
      state.lastDirection = undefined;
      state.confirmCount = 0;
      state.firstConfirmAt = 0;
      state.lastConfirmedDexUpdatedAt =
        undefined;

      return null;
    }

    let direction: "LONG" | "SHORT";
    let spreadPct: number;
    let entryRef: "ASK" | "BID";
    let reason: string;

    if (
      longValid &&
      (!shortValid ||
        status.longSpreadPct >=
          status.shortSpreadPct)
    ) {
      direction = "LONG";
      spreadPct =
        status.longSpreadPct;
      entryRef = "ASK";
      reason =
        "MEXC below DEX anchor";
    } else {
      direction = "SHORT";
      spreadPct =
        status.shortSpreadPct;
      entryRef = "BID";
      reason =
        "MEXC above DEX anchor";
    }

    if (
      direction === "LONG" &&
      status.dexDirectionalDriftPct <
        -config.maxDexDriftPct
    ) {
      return null;
    }

    if (
      direction === "SHORT" &&
      status.dexDirectionalDriftPct >
        config.maxDexDriftPct
    ) {
      return null;
    }

    if (
      state.lastConfirmedDexUpdatedAt ===
      status.dexUpdatedAt
    ) {
      return null;
    }

    state.lastConfirmedDexUpdatedAt =
      status.dexUpdatedAt;

    if (
      state.lastDirection !== direction
    ) {
      state.lastDirection = direction;
      state.confirmCount = 1;
      state.firstConfirmAt = now;
    } else {
      const age =
        now - state.firstConfirmAt;

      if (
        age > SIGNAL_CONFIRM_WINDOW_MS
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

    const totalCostsPct =
      config.mexcEntryFeePct +
      config.mexcExitFeePct +
      config.mexcEntrySlippagePct +
      config.mexcExitSlippagePct +
      config.latencyBufferPct;

    const netEdgePct =
      spreadPct - totalCostsPct;

    if (
      !Number.isFinite(netEdgePct) ||
      netEdgePct < config.minNetEdgePct
    ) {
      return null;
    }

    if (
      now - state.lastSignalAt <
      config.signalCooldownMs
    ) {
      return null;
    }

    state.lastSignalAt = now;
    state.cooldownUntil =
      now + config.signalCooldownMs;

    return {
      id: crypto.randomUUID(),
      detectedAt:
        new Date(now).toISOString(),

      symbol: ticker.symbol,
      direction,

      spreadPct: round(spreadPct),
      netEdgePct: round(netEdgePct),
      priceDeviationPct: round(spreadPct),

      currentPrice: round(
        status.mexcLast,
        6
      ),

      referencePrice: round(
        status.dexPrice,
        6
      ),

      movePct: round(spreadPct),

      dexPrice: round(
        status.dexPrice,
        6
      ),

      mexcPrice: round(
        status.mexcLast,
        6
      ),

      mexcBid: round(
        status.mexcBid,
        6
      ),

      mexcAsk: round(
        status.mexcAsk,
        6
      ),

      mexcTurnover24h: round(
        status.mexcTurnover24h,
        4
      ),

      dexLiquidityUsd: round(
        status.dexLiquidityUsd,
        2
      ),

      dexVolumeM5: round(
        status.dexVolumeM5,
        2
      ),

      dexBuysM5:
        status.dexBuysM5,

      dexSellsM5:
        status.dexSellsM5,

      dexId: status.dexId,
      chainId: status.chainId,
      quoteSymbol: status.quoteSymbol,
      dexPairAddress:
        status.dexPairAddress,

      entryRef,

      mexcBookSpreadPct: round(
        status.mexcBookSpreadPct
      ),

      anchorAgeMs:
        status.anchorAgeMs,

      dexUpdatedAt:
        status.dexUpdatedAt,

      dexDriftPct: round(
        status.dexDriftPct
      ),

      dexDirectionalDriftPct:
        round(
          status.dexDirectionalDriftPct
        ),

      confirmCount:
        state.confirmCount,

      reason
    };
  }

  private isValidDexPair(
    pair: DexPair
  ): boolean {
    return (
      isPositiveFinite(pair.priceUsd) &&
      isNonNegativeFinite(
        pair.liquidityUsd
      ) &&
      isNonNegativeFinite(
        pair.volumeM5
      ) &&
      Number.isInteger(pair.buysM5) &&
      pair.buysM5 >= 0 &&
      Number.isInteger(pair.sellsM5) &&
      pair.sellsM5 >= 0 &&
      typeof pair.dexId === "string" &&
      pair.dexId.length > 0 &&
      typeof pair.chainId === "string" &&
      pair.chainId.length > 0 &&
      typeof pair.quoteSymbol === "string" &&
      pair.quoteSymbol.length > 0 &&
      typeof pair.pairAddress === "string" &&
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
        confirmCount: 0,
        firstConfirmAt: 0,
        cooldownUntil: 0,
        lastSignalAt: 0
      };

      this.states.set(symbol, state);
    }

    return state;
  }

  private calculateDexDrift(
    history: Array<{
      price: number;
      ts: number;
    }>
  ): {
    rangePct: number;
    directionalPct: number;
  } {
    const cutoff =
      Date.now() -
      DEX_HISTORY_WINDOW_MS;

    const recent = history
      .filter(
        (item) =>
          item.ts >= cutoff &&
          isPositiveFinite(item.price)
      )
      .slice(-DEX_DRIFT_POINTS);

    if (
      recent.length <
      MIN_DEX_HISTORY_POINTS
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

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const first = prices[0];
    const last =
      prices[prices.length - 1];
    const mid = (min + max) / 2;

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
        ((max - min) / mid) * 100,
      directionalPct:
        ((last - first) / first) * 100
    };
  }
}
