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
  dexHistory: Array<{
    price: number;
    ts: number;
  }>;

  lastDirection?: "LONG" | "SHORT";
  confirmCount: number;
  firstConfirmAt: number;
  cooldownUntil: number;
  lastSignalAt: number;
}

// Локальные защитные ограничения.
// Их можно позже перенести в config.ts.
const DEX_ANCHOR_MAX_RATIO = 2;
const DEX_HISTORY_WINDOW_MS = 120_000;
const DEX_DRIFT_POINTS = 5;
const SIGNAL_CONFIRM_WINDOW_MS = 5_000;
const MIN_DEX_HISTORY_POINTS = 2;

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

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidDexAnchor(
  dexPrice: number,
  mexcPrice: number
): boolean {
  if (!isPositiveFinite(dexPrice)) return false;
  if (!isPositiveFinite(mexcPrice)) return false;

  const ratio =
    Math.max(dexPrice, mexcPrice) /
    Math.min(dexPrice, mexcPrice);

  return ratio <= DEX_ANCHOR_MAX_RATIO;
}

export class SpreadEngine {
  private readonly dexSnapshots = new Map<string, DexSnapshot>();
  private readonly states = new Map<string, SymbolState>();
  private readonly dexMapper: DexMapper;

  constructor(dexMapper: DexMapper) {
    this.dexMapper = dexMapper;
  }

  /**
   * Возвращает единый ключ для:
   * - DEX snapshot;
   * - DEX history;
   * - confirmations;
   * - cooldown;
   * - signal state.
   */
  private getSnapshotKey(symbol: string): string {
    const normalized = normalizeSymbol(symbol);
    const mapping = this.dexMapper.get(symbol);

    return mapping?.normalizedDexKey ?? normalized;
  }

  updateDexPrice(symbol: string, pair: DexPair): void {
    const now = Date.now();
    const snapshotKey = this.getSnapshotKey(symbol);

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

    const state = this.getState(snapshotKey);

    state.dexHistory.push({
      price: pair.priceUsd,
      ts: now
    });

    const cutoff = now - DEX_HISTORY_WINDOW_MS;

    state.dexHistory = state.dexHistory.filter(
      (point) => point.ts >= cutoff
    );

    logger.info(
      {
        symbol,
        snapshotKey,
        price: pair.priceUsd.toFixed(6),
        liquidity: pair.liquidityUsd.toFixed(0),
        volumeM5: pair.volumeM5.toFixed(0),
        historySize: state.dexHistory.length,
        snapshotKeysCount: this.dexSnapshots.size
      },
      "DEX snapshot saved"
    );
  }

  getAnchorStatus(ticker: MexcTicker): AnchorStatus | null {
    const tickerSymbol = String(ticker.symbol);
    const snapshotKey = this.getSnapshotKey(tickerSymbol);
    const mapping = this.dexMapper.get(tickerSymbol);

    // 1. Нет active mapping
    if (!mapping || mapping.status !== "active") {
      logger.debug(
        {
          tickerSymbol,
          mappingStatus: mapping?.status,
          snapshotKey,
          mappingChainId: mapping?.chainId,
          mappingDexPairAddress: mapping?.dexPairAddress
        },
        "getAnchorStatus: no active mapping, skipping"
      );

      return null;
    }

    // 2. Нет DEX snapshot
    const anchor = this.dexSnapshots.get(snapshotKey);

    if (!anchor) {
      const mappingAgeMs = mapping.mappedAt
        ? Date.now() - new Date(mapping.mappedAt).getTime()
        : Infinity;

      if (mappingAgeMs < 30_000) {
        logger.debug(
          {
            tickerSymbol,
            snapshotKey,
            mappingDexKey: mapping.normalizedDexKey,
            snapshotKeysCount: this.dexSnapshots.size,
            mappingAgeMs
          },
          "getAnchorStatus: mapped ticker has no anchor snapshot yet"
        );
      } else {
        logger.info(
          {
            tickerSymbol,
            snapshotKey,
            mappingDexKey: mapping.normalizedDexKey,
            snapshotKeysCount: this.dexSnapshots.size,
            mappingAgeMs
          },
          "getAnchorStatus: mapped ticker has no anchor snapshot"
        );
      }

      return null;
    }

    if (!this.isValidDexPair(anchor)) {
      logger.warn(
        {
          tickerSymbol,
          snapshotKey,
          priceUsd: anchor.priceUsd,
          liquidityUsd: anchor.liquidityUsd,
          volumeM5: anchor.volumeM5
        },
        "getAnchorStatus: invalid DEX snapshot"
      );

      return null;
    }

    const now = Date.now();
    const anchorAgeMs = Math.max(0, now - anchor.updatedAt);

    let mexcBid = Number((ticker as any).bid1);
    let mexcAsk = Number((ticker as any).ask1);
    const mexcLast = Number(ticker.lastPrice);
    const mexcTurnover24h = Number(ticker.amount24);

    // 3. Некорректные котировки MEXC
    if (
      !isPositiveFinite(mexcBid) ||
      !isPositiveFinite(mexcAsk) ||
      !isPositiveFinite(mexcLast)
    ) {
      logger.debug(
        {
          tickerSymbol,
          mexcBid,
          mexcAsk,
          mexcLast
        },
        "getAnchorStatus: invalid MEXC quotes, skipping"
      );

      return null;
    }

    // Оставляем turnover отдельно:
    // отсутствие корректного turnover не должно ломать расчёт цен,
    // но evaluate() ниже отфильтрует его через конфигурацию.
    const normalizedTurnover = isNonNegativeFinite(mexcTurnover24h)
      ? mexcTurnover24h
      : 0;

    // 4. Crossed book нельзя исправлять swap-ом.
    // Это признак некорректного snapshot или проблемного парсинга.
    if (mexcAsk < mexcBid) {
      logger.warn(
        {
          tickerSymbol,
          mexcBid,
          mexcAsk
        },
        "getAnchorStatus: crossed MEXC book, skipping"
      );

      return null;
    }

    const mexcMid = (mexcBid + mexcAsk) / 2;

    if (!isPositiveFinite(mexcMid)) {
      return null;
    }

    const mexcBookSpreadPct =
      ((mexcAsk - mexcBid) / mexcMid) * 100;

    const state = this.getState(snapshotKey);

    const dexDriftPct = this.calculateDexDriftPct(
      state.dexHistory
    );

    const longSpreadPct =
      ((anchor.priceUsd - mexcAsk) / mexcAsk) * 100;

    const shortSpreadPct =
      ((mexcBid - anchor.priceUsd) / mexcBid) * 100;

    // 5. Проверка адекватности DEX anchor
    const dexPrice = anchor.priceUsd;

    if (!isValidDexAnchor(dexPrice, mexcMid)) {
      const ratio =
        Math.max(dexPrice, mexcMid) /
        Math.min(dexPrice, mexcMid);

      logger.warn(
        {
          symbol: tickerSymbol,
          dexPrice,
          mexcPrice: mexcMid,
          priceRatio: ratio,
          reason: "DEX/MEXC price ratio too high"
        },
        "Invalid DEX anchor"
      );

      return null;
    }

    return {
      symbol: tickerSymbol,
      dexPrice,
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
      mexcLast,
      mexcTurnover24h: normalizedTurnover,
      mexcBookSpreadPct,
      longSpreadPct,
      shortSpreadPct
    };
  }

  evaluate(ticker: MexcTicker): FlipSignal | null {
    const status = this.getAnchorStatus(ticker);

    if (!status) {
      logger.debug(
        {
          symbol: ticker.symbol
        },
        "evaluate(): no anchor status, skipping"
      );

      return null;
    }

    const snapshotKey = this.getSnapshotKey(ticker.symbol);
    const state = this.getState(snapshotKey);

    // До расчёта drift должна быть минимальная история.
    if (state.dexHistory.length < MIN_DEX_HISTORY_POINTS) {
      logger.debug(
        {
          symbol: ticker.symbol,
          snapshotKey,
          historySize: state.dexHistory.length,
          required: MIN_DEX_HISTORY_POINTS
        },
        "evaluate(): not enough DEX history"
      );

      return null;
    }

    // 1. Свежесть DEX anchor
    if (status.anchorAgeMs > config.maxDexAnchorAgeMs) {
      logger.warn(
        {
          symbol: ticker.symbol,
          anchorAgeMs: status.anchorAgeMs,
          maxAge: config.maxDexAnchorAgeMs
        },
        "DEX anchor too old"
      );

      return null;
    }

    // 2. DEX liquidity
    if (
      !isNonNegativeFinite(status.dexLiquidityUsd) ||
      status.dexLiquidityUsd < config.dexMinLiquidityUsd
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          liquidity: status.dexLiquidityUsd,
          minLiquidity: config.dexMinLiquidityUsd
        },
        "DEX liquidity too low or invalid"
      );

      return null;
    }

    // 3. DEX volume
    if (
      !isNonNegativeFinite(status.dexVolumeM5) ||
      status.dexVolumeM5 < config.dexMinVolumeM5Usd
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          volumeM5: status.dexVolumeM5,
          minVolumeM5: config.dexMinVolumeM5Usd
        },
        "DEX volume too low or invalid"
      );

      return null;
    }

    // 4. MEXC turnover
    if (
      !isNonNegativeFinite(status.mexcTurnover24h) ||
      status.mexcTurnover24h < config.minMexcTurnover24h
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          turnover24h: status.mexcTurnover24h,
          minTurnover24h: config.minMexcTurnover24h
        },
        "MEXC turnover too low or invalid"
      );

      return null;
    }

    // 5. MEXC book spread
    if (
      !isNonNegativeFinite(status.mexcBookSpreadPct) ||
      status.mexcBookSpreadPct > config.maxMexcBookSpreadPct
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          bookSpreadPct: status.mexcBookSpreadPct.toFixed(3),
          maxBookSpreadPct: config.maxMexcBookSpreadPct
        },
        "MEXC book spread too wide or invalid"
      );

      return null;
    }

    // 6. DEX drift
    if (
      !isNonNegativeFinite(status.dexDriftPct) ||
      status.dexDriftPct > config.maxDexDriftPct
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          driftPct: status.dexDriftPct.toFixed(3),
          maxDriftPct: config.maxDexDriftPct
        },
        "DEX drift too high or invalid"
      );

      return null;
    }

    const now = Date.now();

    // 7. Process cooldown
    if (now < state.cooldownUntil) {
      logger.debug(
        {
          symbol: ticker.symbol,
          cooldownRemaining:
            (state.cooldownUntil - now) / 1000
        },
        "In process cooldown"
      );

      return null;
    }

    let direction: "LONG" | "SHORT" | null = null;
    let spreadPct = 0;
    let entryRef: "ASK" | "BID" = "ASK";
    let reason = "";

    // 8. Выбор направления
    if (
      isFinite(status.longSpreadPct) &&
      status.longSpreadPct >= config.minSpreadPct
    ) {
      direction = "LONG";
      spreadPct = status.longSpreadPct;
      entryRef = "ASK";
      reason = "MEXC below DEX anchor";
    } else if (
      isFinite(status.shortSpreadPct) &&
      status.shortSpreadPct >= config.minSpreadPct
    ) {
      direction = "SHORT";
      spreadPct = status.shortSpreadPct;
      entryRef = "BID";
      reason = "MEXC above DEX anchor";
    } else {
      state.lastDirection = undefined;
      state.confirmCount = 0;
      state.firstConfirmAt = 0;

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

    // 9. Подтверждение направления
    if (state.lastDirection !== direction) {
      state.lastDirection = direction;
      state.confirmCount = 1;
      state.firstConfirmAt = now;
    } else {
      const confirmationAge =
        now - state.firstConfirmAt;

      if (confirmationAge > SIGNAL_CONFIRM_WINDOW_MS) {
        state.confirmCount = 1;
        state.firstConfirmAt = now;
      } else {
        state.confirmCount += 1;
      }
    }

    if (state.confirmCount < config.signalConfirmTicks) {
      logger.debug(
        {
          symbol: ticker.symbol,
          direction,
          confirmCount: state.confirmCount,
          required: config.signalConfirmTicks,
          confirmationAgeMs:
            state.firstConfirmAt > 0
              ? now - state.firstConfirmAt
              : 0
        },
        "evaluate(): not enough confirmations"
      );

      return null;
    }

    // 10. Проверка валидности spread и costs
    if (!Number.isFinite(spreadPct) || spreadPct <= 0) {
      logger.warn(
        {
          symbol: ticker.symbol,
          direction,
          spreadPct
        },
        "Invalid spread value"
      );

      return null;
    }

    // В текущем config доступны только эти два параметра.
    // Gas/funding нужно добавить в config отдельно,
    // когда появятся реальные модели их расчёта.
    const totalCostsPct =
      config.assumedFeesPct +
      config.assumedSlippagePct;

    const netEdgePct =
      spreadPct - totalCostsPct;

    if (
      !Number.isFinite(netEdgePct) ||
      netEdgePct < config.minNetEdgePct
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          direction,
          spreadPct: spreadPct.toFixed(3),
          costsPct: totalCostsPct,
          netEdgePct: netEdgePct.toFixed(3),
          minNetEdge: config.minNetEdgePct
        },
        "Net edge too low"
      );

      return null;
    }

    // 11. Signal cooldown
    if (
      now - state.lastSignalAt <
      config.signalCooldownMs
    ) {
      logger.debug(
        {
          symbol: ticker.symbol,
          signalCooldownRemaining:
            (
              config.signalCooldownMs -
              (now - state.lastSignalAt)
            ) / 1000
        },
        "Signal cooldown"
      );

      return null;
    }

    state.lastSignalAt = now;
    state.cooldownUntil =
      now + config.signalCooldownMs;

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
      "SIGNAL GENERATED"
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
      dexBuysM5: status.dexBuysM5,
      dexSellsM5: status.dexSellsM5,

      dexId: status.dexId,
      chainId: status.chainId,
      quoteSymbol: status.quoteSymbol,
      dexPairAddress: status.dexPairAddress,

      entryRef,
      mexcBookSpreadPct: round(
        status.mexcBookSpreadPct
      ),
      anchorAgeMs: status.anchorAgeMs,
      dexDriftPct: round(status.dexDriftPct),
      confirmCount: state.confirmCount,
      reason
    };
  }

  private isValidDexPair(pair: DexPair): boolean {
    return (
      isPositiveFinite(pair.priceUsd) &&
      isNonNegativeFinite(pair.liquidityUsd) &&
      isNonNegativeFinite(pair.volumeM5) &&
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

  private getState(symbol: string): SymbolState {
    let state = this.states.get(symbol);

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

  private calculateDexDriftPct(
    history: Array<{ price: number; ts: number }>
  ): number {
    const now = Date.now();
    const cutoff = now - DEX_HISTORY_WINDOW_MS;

    const recent = history
      .filter(
        (item) =>
          item.ts >= cutoff &&
          isPositiveFinite(item.price)
      )
      .slice(-DEX_DRIFT_POINTS);

    if (recent.length < MIN_DEX_HISTORY_POINTS) {
      return 0;
    }

    const prices = recent.map(
      (item) => item.price
    );

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const mid = (min + max) / 2;

    if (!isPositiveFinite(mid)) {
      return 0;
    }

    return ((max - min) / mid) * 100;
  }
}
