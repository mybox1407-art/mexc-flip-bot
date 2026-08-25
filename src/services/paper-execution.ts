import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

import type {
  CloseReason,
  FlipSignal,
  MexcTicker,
  PaperTrade
} from "../types.js";

import type {
  AnchorStatus
} from "./spread-engine.js";

type PaperAction =
  | {
      action: "OPEN";
      trade: PaperTrade;
    }
  | {
      action: "CLOSE";
      trade: PaperTrade;
    };

const MAX_ENTRY_SPREAD_PCT =
  4.5;

const MIN_NET_PROFIT_PCT =
  0.05;

const SYMBOL_STOP_COOLDOWN_MS =
  15 * 60 * 1000;

const MAX_CONSECUTIVE_STOPS =
  2;

const SYMBOL_BAN_DURATION_MS =
  2 * 60 * 60 * 1000;

/**
 * Двухфазный стоп:
 *
 * 0–30 секунд: 0.40%
 * после 30 секунд: 1.5%
 */
const INITIAL_STOP_DURATION_MS =
  30 * 1000;

const INITIAL_STOP_DISTANCE_PCT =
  0.40;

const REGULAR_STOP_DISTANCE_PCT =
  1.5;

/**
 * Выход при движении DEX-якоря
 * против направления позиции на 0.60%.
 */
const ANCHOR_BREAK_DISTANCE_PCT =
  0.60;

/**
 * Аварийная защита по net PnL.
 *
 * Защита не работает в первые 3 секунды,
 * чтобы не закрываться только из-за bid/ask
 * и round-trip комиссии.
 *
 * После 3 секунд:
 * net PnL <= -0.50%
 * => немедленный выход.
 */
const MAX_ANCHOR_BREAK_LOSS_PCT =
  0.50;

const ANCHOR_LOSS_MIN_HOLD_MS =
  3 * 1000;

/**
 * Максимальный spread стакана MEXC
 * для разрешения входа.
 */
const MAX_ENTRY_MEXC_BOOK_SPREAD_PCT =
  0.15;

/**
 * Momentum-фильтр перед входом.
 */
const ENTRY_MOMENTUM_WINDOW_MS =
  30 * 1000;

const ENTRY_MOMENTUM_MIN_SAMPLE_AGE_MS =
  20 * 1000;

const ENTRY_MOMENTUM_BLOCK_PCT =
  0.15;

const PRICE_HISTORY_TTL_MS =
  90 * 1000;

interface SymbolRiskState {
  consecutiveStops: number;
  cooldownUntil: number;
  bannedUntil: number;
}

interface PriceSample {
  timestamp: number;
  mid: number;
}

interface EntryDiagnostics {
  entryCheckedAt: number;
  entryAnchorAgeMs: number;
  entryAnchorIsFresh: boolean;
  entryDexUpdatedAt: number;
  entryDexPrice: number;
  entryMexcBid: number;
  entryMexcAsk: number;
  entryMexcMid: number;
  entryMexcBookSpreadPct: number;
  entrySpreadPct: number;
  entryNetEdgePct: number;
  entryDexDriftPct: number;
  entryDexDirectionalDriftPct: number;
  entryDexTrendSlopePct: number;
  entryMomentumPct: number;
  entryMomentumBlocked: boolean;
  entryMomentumWindowMs: number;
  maxEntrySpreadPct: number;
  maxEntryMexcBookSpreadPct: number;
  maxEntryAnchorAgeMs: number;
  anchorBreakDistancePct: number;
  maxAnchorBreakLossPct: number;
  anchorLossMinHoldMs: number;
  initialStopDistancePct: number;
  initialStopPrice: number;
}

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
  digits = 6
): number {
  const factor =
    10 ** digits;

  return (
    Math.round(value * factor) /
    factor
  );
}

function isFinitePositive(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

export class PaperExecutionService {
  private readonly openTrades =
    new Map<string, PaperTrade>();

  private readonly processedCloseTrades =
    new Set<string>();

  private readonly liquidityAtEntry =
    new Map<string, number>();

  private readonly symbolRisk =
    new Map<string, SymbolRiskState>();

  private readonly priceHistory =
    new Map<string, PriceSample[]>();

  private readonly entryDiagnostics =
    new Map<string, EntryDiagnostics>();

  private readonly maxOpenTrades =
    3;

  private readonly tradeAllocationPct =
    0.3;

  private depositUsd =
    100;

  getDepositUsd(): number {
    return round(
      this.depositUsd,
      4
    );
  }

  getOpenTradesCount(): number {
    return this.openTrades.size;
  }

  /**
   * Вызывается на каждом входящем MEXC ticker.
   * Только сохраняет историю цены.
   *
   * Вызов должен находиться в index.ts
   * до spreadEngine.evaluate().
   */
  recordTicker(
    ticker: MexcTicker
  ): void {
    const positionKey =
      normalizeSymbol(
        ticker.symbol
      );

    this.recordPriceSample(
      positionKey,
      Number(
        ticker.bid1
      ),
      Number(
        ticker.ask1
      ),
      Date.now()
    );
  }

  private getTotalCostsPct(): number {
    return config.roundTripCostPct;
  }

  private getUsedCapitalUsd(): number {
    let usedCapitalUsd =
      0;

    for (
      const trade of this.openTrades.values()
    ) {
      usedCapitalUsd +=
        trade.qtyUsd;
    }

    return usedCapitalUsd;
  }

  private getMaxTotalExposureUsd(): number {
    return (
      this.depositUsd *
      config.paperMaxTotalExposurePct
    );
  }

  private getStopDistancePct(
    holdMs = 0
  ): number {
    if (
      holdMs <
      INITIAL_STOP_DURATION_MS
    ) {
      return INITIAL_STOP_DISTANCE_PCT;
    }

    return REGULAR_STOP_DISTANCE_PCT;
  }

  private getStopSlippagePct(): number {
    return config.paperStopSlippagePct;
  }

  private getMinHoldMs(): number {
    return config.paperMinHoldMs;
  }

  private getTrailingTriggerPct(): number {
    return config.paperTrailingTriggerPct;
  }

  private getTrailingDistancePct(): number {
    return config.paperTrailingDistancePct;
  }

  private getSymbolRiskState(
    positionKey: string
  ): SymbolRiskState {
    let state =
      this.symbolRisk.get(
        positionKey
      );

    if (!state) {
      state = {
        consecutiveStops: 0,
        cooldownUntil: 0,
        bannedUntil: 0
      };

      this.symbolRisk.set(
        positionKey,
        state
      );
    }

    return state;
  }

  private recordPriceSample(
    positionKey: string,
    bid: number,
    ask: number,
    timestamp: number
  ): void {
    if (
      !isFinitePositive(bid) ||
      !isFinitePositive(ask) ||
      ask < bid
    ) {
      return;
    }

    const mid =
      (
        bid +
        ask
      ) / 2;

    if (
      !isFinitePositive(mid)
    ) {
      return;
    }

    let samples =
      this.priceHistory.get(
        positionKey
      );

    if (!samples) {
      samples = [];

      this.priceHistory.set(
        positionKey,
        samples
      );
    }

    samples.push({
      timestamp,
      mid
    });

    const cutoff =
      timestamp -
      PRICE_HISTORY_TTL_MS;

    while (
      samples.length > 0 &&
      samples[0].timestamp <
        cutoff
    ) {
      samples.shift();
    }
  }

  private getMomentumPct(
    positionKey: string,
    now: number
  ): number | null {
    const samples =
      this.priceHistory.get(
        positionKey
      );

    if (
      !samples ||
      samples.length < 2
    ) {
      return null;
    }

    const targetTimestamp =
      now -
      ENTRY_MOMENTUM_WINDOW_MS;

    let reference:
      | PriceSample
      | null = null;

    for (
      const sample of samples
    ) {
      const ageMs =
        now -
        sample.timestamp;

      if (
        ageMs <
        ENTRY_MOMENTUM_MIN_SAMPLE_AGE_MS
      ) {
        continue;
      }

      if (
        !reference ||
        Math.abs(
          sample.timestamp -
          targetTimestamp
        ) <
          Math.abs(
            reference.timestamp -
            targetTimestamp
          )
      ) {
        reference =
          sample;
      }
    }

    if (
      !reference
    ) {
      return null;
    }

    const latest =
      samples[
        samples.length - 1
      ];

    if (
      !isFinitePositive(
        reference.mid
      ) ||
      !isFinitePositive(
        latest?.mid
      )
    ) {
      return null;
    }

    return (
      (
        (
          latest.mid -
          reference.mid
        ) /
        reference.mid
      ) * 100
    );
  }

  private isMomentumAgainstPosition(
    direction: "LONG" | "SHORT",
    momentumPct: number
  ): boolean {
    if (
      direction === "SHORT"
    ) {
      return (
        momentumPct >=
        ENTRY_MOMENTUM_BLOCK_PCT
      );
    }

    return (
      momentumPct <=
      -ENTRY_MOMENTUM_BLOCK_PCT
    );
  }

  private estimateExecutableDexPrice(
    anchor: AnchorStatus,
    qtyUsd: number,
    direction: "LONG" | "SHORT"
  ): number {
    void qtyUsd;
    void direction;

    if (
      !isFinitePositive(
        anchor.dexPrice
      )
    ) {
      return NaN;
    }

    return anchor.dexPrice;
  }

  private calculateStopPrice(
    entryPrice: number,
    direction: "LONG" | "SHORT",
    stopDistancePct: number
  ): number {
    const multiplier =
      direction === "LONG"
        ? 1 - stopDistancePct / 100
        : 1 + stopDistancePct / 100;

    return (
      entryPrice *
      multiplier
    );
  }

  private updateTwoPhaseStop(
    trade: PaperTrade,
    holdMs: number
  ): void {
    if (
      trade.trailActive
    ) {
      return;
    }

    const stopDistancePct =
      this.getStopDistancePct(
        holdMs
      );

    const newStopPrice =
      this.calculateStopPrice(
        trade.entryPrice,
        trade.direction,
        stopDistancePct
      );

    if (
      !isFinitePositive(
        newStopPrice
      )
    ) {
      return;
    }

    trade.stopPrice =
      round(
        newStopPrice
      );

    trade.stopDistancePct =
      round(
        stopDistancePct,
        4
      );
  }

  private isStopTriggered(
    trade: PaperTrade,
    exitBid: number,
    exitAsk: number
  ): boolean {
    const stopPrice =
      trade.stopPrice;

    if (
      !isFinitePositive(
        stopPrice
      )
    ) {
      return false;
    }

    if (
      trade.direction === "LONG"
    ) {
      return (
        exitBid <=
        stopPrice
      );
    }

    return (
      exitAsk >=
      stopPrice
    );
  }

  private getStopExecutionPrice(
    trade: PaperTrade
  ): number {
    const stopPrice =
      trade.stopPrice;

    if (
      !isFinitePositive(
        stopPrice
      )
    ) {
      throw new Error(
        `Invalid stop price for trade ${trade.id}`
      );
    }

    const slippagePct =
      this.getStopSlippagePct();

    if (
      trade.direction === "LONG"
    ) {
      return (
        stopPrice *
        (1 - slippagePct / 100)
      );
    }

    return (
      stopPrice *
        (1 + slippagePct / 100)
    );
  }

  private calculateGrossPnlPct(
    trade: PaperTrade,
    exitPrice: number
  ): number {
    if (
      trade.direction === "LONG"
    ) {
      return (
        (
          (
            exitPrice -
            trade.entryPrice
          ) /
          trade.entryPrice
        ) * 100
      );
    }

    return (
      (
        (
          trade.entryPrice -
          exitPrice
        ) /
        trade.entryPrice
      ) * 100
    );
  }

  private isAnchorBroken(
    trade: PaperTrade,
    currentDexPrice: number
  ): boolean {
    if (
      !isFinitePositive(
        trade.dexAnchorAtEntry
      ) ||
      !isFinitePositive(
        currentDexPrice
      )
    ) {
      return false;
    }

    const dexMovePct =
      (
        (
          currentDexPrice -
          trade.dexAnchorAtEntry
        ) /
        trade.dexAnchorAtEntry
      ) * 100;

    if (
      trade.direction === "LONG"
    ) {
      return (
        dexMovePct <=
        -ANCHOR_BREAK_DISTANCE_PCT
      );
    }

    return (
      dexMovePct >=
      ANCHOR_BREAK_DISTANCE_PCT
    );
  }

  private updateTrailingStop(
    trade: PaperTrade,
    exitBid: number,
    exitAsk: number
  ): void {
    const triggerPct =
      this.getTrailingTriggerPct();

    const distancePct =
      this.getTrailingDistancePct();

    if (
      triggerPct <= 0 ||
      distancePct <= 0
    ) {
      return;
    }

    const currentPrice =
      trade.direction === "LONG"
        ? exitBid
        : exitAsk;

    if (
      !isFinitePositive(
        currentPrice
      )
    ) {
      return;
    }

    const movePct =
      trade.direction === "LONG"
        ? (
            (
              currentPrice -
              trade.entryPrice
            ) /
            trade.entryPrice
          ) * 100
        : (
            (
              trade.entryPrice -
              currentPrice
            ) /
            trade.entryPrice
          ) * 100;

    const bestPrice =
      trade.trailBestPrice ??
      currentPrice;

    const previousStopPrice =
      trade.stopPrice;

    if (
      !trade.trailActive
    ) {
      if (
        movePct <
        triggerPct
      ) {
        return;
      }

      trade.trailActive =
        true;

      trade.trailBestPrice =
        currentPrice;

      const newStopPrice =
        trade.direction === "LONG"
          ? currentPrice *
            (1 - distancePct / 100)
          : currentPrice *
            (1 + distancePct / 100);

      if (
        !isFinitePositive(
          previousStopPrice
        ) ||
        (
          trade.direction === "LONG"
            ? newStopPrice >
              previousStopPrice
            : newStopPrice <
              previousStopPrice
        )
      ) {
        trade.stopPrice =
          round(
            newStopPrice
          );
      }

      logger.debug(
        {
          tradeId:
            trade.id,
          symbol:
            trade.symbol,
          direction:
            trade.direction,
          movePct:
            round(
              movePct,
              4
            ),
          triggerPct,
          distancePct,
          previousStopPrice,
          newStopPrice:
            trade.stopPrice
        },
        "Trailing stop activated"
      );

      return;
    }

    if (
      trade.direction === "LONG"
    ) {
      if (
        currentPrice >
        bestPrice
      ) {
        trade.trailBestPrice =
          currentPrice;

        const newStopPrice =
          currentPrice *
          (1 - distancePct / 100);

        if (
          !isFinitePositive(
            previousStopPrice
          ) ||
          newStopPrice >
            previousStopPrice
        ) {
          trade.stopPrice =
            round(
              newStopPrice
            );
        }
      }

      return;
    }

    if (
      currentPrice <
      bestPrice
    ) {
      trade.trailBestPrice =
        currentPrice;

      const newStopPrice =
        currentPrice *
        (1 + distancePct / 100);

      if (
        !isFinitePositive(
          previousStopPrice
        ) ||
        newStopPrice <
          previousStopPrice
      ) {
        trade.stopPrice =
          round(
            newStopPrice
          );
      }
    }
  }

  onSignal(
    signal: FlipSignal
  ): PaperAction | null {
    const positionKey =
      normalizeSymbol(
        signal.symbol
      );

    const now =
      Date.now();

    const riskState =
      this.getSymbolRiskState(
        positionKey
      );

    if (
      now <
      riskState.bannedUntil
    ) {
      logger.debug(
        {
          symbol:
            signal.symbol,
          bannedUntil:
            new Date(
              riskState.bannedUntil
            ).toISOString()
        },
        "Signal skipped: symbol is temporarily banned due to consecutive stop losses"
      );

      return null;
    }

    if (
      now <
      riskState.cooldownUntil
    ) {
      logger.debug(
        {
          symbol:
            signal.symbol,
          cooldownUntil:
            new Date(
              riskState.cooldownUntil
            ).toISOString()
        },
        "Signal skipped: symbol is in post-stop cooldown"
      );

      return null;
    }

    if (
      signal.spreadPct >
      MAX_ENTRY_SPREAD_PCT
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction,
          spreadPct:
            round(
              signal.spreadPct,
              4
            ),
          maxEntrySpreadPct:
            MAX_ENTRY_SPREAD_PCT,
          anchorAgeMs:
            signal.anchorAgeMs,
          dexUpdatedAt:
            signal.dexUpdatedAt
        },
        "Signal skipped: entry spread exceeds safety threshold"
      );

      return null;
    }

    if (
      this.openTrades.has(
        positionKey
      )
    ) {
      logger.debug(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction
        },
        "Signal skipped: position already open"
      );

      return null;
    }

    if (
      this.openTrades.size >=
      this.maxOpenTrades
    ) {
      logger.debug(
        {
          symbol:
            signal.symbol,
          openTrades:
            this.openTrades.size,
          maxOpenTrades:
            this.maxOpenTrades
        },
        "Signal skipped: maximum open trades reached"
      );

      return null;
    }

    if (
      !isFinitePositive(
        this.depositUsd
      )
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          depositUsd:
            this.depositUsd
        },
        "Signal skipped: invalid deposit"
      );

      return null;
    }

    const mexcBid =
      Number(
        signal.mexcBid
      );

    const mexcAsk =
      Number(
        signal.mexcAsk
      );

    if (
      !isFinitePositive(
        mexcBid
      ) ||
      !isFinitePositive(
        mexcAsk
      ) ||
      mexcAsk < mexcBid
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction,
          mexcBid,
          mexcAsk,
          mexcBookSpreadPct:
            signal.mexcBookSpreadPct
        },
        "Signal skipped: invalid MEXC order book"
      );

      return null;
    }

    if (
      signal.mexcBookSpreadPct >
      MAX_ENTRY_MEXC_BOOK_SPREAD_PCT
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction,
          mexcBookSpreadPct:
            signal.mexcBookSpreadPct,
          maxEntryMexcBookSpreadPct:
            MAX_ENTRY_MEXC_BOOK_SPREAD_PCT,
          spreadPct:
            signal.spreadPct,
          anchorAgeMs:
            signal.anchorAgeMs
        },
        "Signal skipped: MEXC order book spread is too wide for entry"
      );

      return null;
    }

    const historySamples =
      this.priceHistory.get(
        positionKey
      )?.length ?? 0;

    const entryMomentumPct =
      this.getMomentumPct(
        positionKey,
        now
      );

    if (
      entryMomentumPct ===
      null
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction,
          historySamples,
          requiredWindowMs:
            ENTRY_MOMENTUM_WINDOW_MS,
          minSampleAgeMs:
            ENTRY_MOMENTUM_MIN_SAMPLE_AGE_MS,
          priceHistoryTtlMs:
            PRICE_HISTORY_TTL_MS
        },
        "Signal skipped: insufficient MEXC price history for entry"
      );

      return null;
    }

    const entryMomentumBlocked =
      this.isMomentumAgainstPosition(
        signal.direction,
        entryMomentumPct
      );

    if (
      entryMomentumBlocked
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction,
          entryMomentumPct:
            round(
              entryMomentumPct,
              4
            ),
          blockPct:
            ENTRY_MOMENTUM_BLOCK_PCT,
          windowMs:
            ENTRY_MOMENTUM_WINDOW_MS,
          historySamples
        },
        "Signal skipped: MEXC momentum is moving against the intended position"
      );

      return null;
    }

    const dexMomentumAgainstPosition =
      signal.direction === "LONG"
        ? signal.dexDirectionalDriftPct < -0.10 ||
          (signal.dexTrendSlopePct ?? 0) < -0.10
        : signal.dexDirectionalDriftPct > 0.10 ||
          (signal.dexTrendSlopePct ?? 0) > 0.10;
    
    if (dexMomentumAgainstPosition) {
      logger.warn(
        {
          symbol: signal.symbol,
          direction: signal.direction,
          dexDirectionalDriftPct:
            signal.dexDirectionalDriftPct,
          dexTrendSlopePct:
            signal.dexTrendSlopePct ?? 0,
          blockPct: 0.10
        },
        "Signal skipped: DEX momentum is moving against the intended position"
      );
    
      return null;
    }
        
    const entryMexcMid =
      (
        mexcBid +
        mexcAsk
      ) / 2;

    const entryPrice =
      signal.direction === "LONG"
        ? mexcAsk
        : mexcBid;

    if (
      !isFinitePositive(
        entryPrice
      )
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction,
          entryPrice
        },
        "Invalid paper entry price"
      );

      return null;
    }

    const depositAtEntry =
      this.depositUsd;

    const qtyUsd =
      depositAtEntry *
      this.tradeAllocationPct;

    const usedCapitalUsd =
      this.getUsedCapitalUsd();

    const maxExposureUsd =
      this.getMaxTotalExposureUsd();

    if (
      usedCapitalUsd +
      qtyUsd >
      maxExposureUsd
    ) {
      logger.debug(
        {
          symbol:
            signal.symbol,
          qtyUsd,
          usedCapitalUsd,
          maxExposureUsd
        },
        "Signal skipped: maximum total exposure reached"
      );

      return null;
    }

    const qtyToken =
      qtyUsd /
      entryPrice;

    if (
      !isFinitePositive(
        qtyUsd
      ) ||
      !isFinitePositive(
        qtyToken
      )
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          depositAtEntry,
          allocationPct:
            this.tradeAllocationPct,
          qtyUsd,
          qtyToken
        },
        "Invalid paper position size"
      );

      return null;
    }

    const anchor: AnchorStatus = {
      symbol:
        signal.symbol,
      dexPrice:
        signal.dexPrice,
      dexLiquidityUsd:
        signal.dexLiquidityUsd,
      dexVolumeM5:
        signal.dexVolumeM5,
      dexBuysM5:
        signal.dexBuysM5,
      dexSellsM5:
        signal.dexSellsM5,
      dexId:
        signal.dexId,
      chainId:
        signal.chainId,
      quoteSymbol:
        signal.quoteSymbol,
      dexPairAddress:
        signal.dexPairAddress,
      anchorAgeMs:
        signal.anchorAgeMs,
      dexUpdatedAt:
        signal.dexUpdatedAt,
      dexDriftPct:
        signal.dexDriftPct,
      dexDirectionalDriftPct:
        signal.dexDirectionalDriftPct,
      dexTrendSlopePct:
        signal.dexTrendSlopePct ??
        0,
      mexcBid,
      mexcAsk,
      mexcLast:
        signal.mexcPrice,
      mexcTurnover24h:
        signal.mexcTurnover24h,
      mexcBookSpreadPct:
        signal.mexcBookSpreadPct,
      longSpreadPct:
        signal.spreadPct,
      shortSpreadPct:
        signal.spreadPct
    };

    const executableDexPrice =
      this.estimateExecutableDexPrice(
        anchor,
        qtyUsd,
        signal.direction
      );

    if (
      !isFinitePositive(
        executableDexPrice
      )
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,
          direction:
            signal.direction,
          executableDexPrice
        },
        "Invalid executable DEX price"
      );

      return null;
    }

    const initialStopDistancePct =
      this.getStopDistancePct(
        0
      );

    const stopPrice =
      this.calculateStopPrice(
        entryPrice,
        signal.direction,
        initialStopDistancePct
      );

    const entryDiagnostics: EntryDiagnostics = {
      entryCheckedAt:
        now,
      entryAnchorAgeMs:
        signal.anchorAgeMs,
      entryAnchorIsFresh:
        Number.isFinite(
          signal.anchorAgeMs
        ) &&
        signal.anchorAgeMs <=
          config.maxDexAnchorAgeMs,
      entryDexUpdatedAt:
        signal.dexUpdatedAt,
      entryDexPrice:
        signal.dexPrice,
      entryMexcBid:
        mexcBid,
      entryMexcAsk:
        mexcAsk,
      entryMexcMid,
      entryMexcBookSpreadPct:
        signal.mexcBookSpreadPct,
      entrySpreadPct:
        signal.spreadPct,
      entryNetEdgePct:
        signal.netEdgePct,
      entryDexDriftPct:
        signal.dexDriftPct,
      entryDexDirectionalDriftPct:
        signal.dexDirectionalDriftPct,
      entryDexTrendSlopePct:
        signal.dexTrendSlopePct ??
        0,
      entryMomentumPct,
      entryMomentumBlocked,
      entryMomentumWindowMs:
        ENTRY_MOMENTUM_WINDOW_MS,
      maxEntrySpreadPct:
        MAX_ENTRY_SPREAD_PCT,
      maxEntryMexcBookSpreadPct:
        MAX_ENTRY_MEXC_BOOK_SPREAD_PCT,
      maxEntryAnchorAgeMs:
        config.maxDexAnchorAgeMs,
      anchorBreakDistancePct:
        ANCHOR_BREAK_DISTANCE_PCT,
      maxAnchorBreakLossPct:
        MAX_ANCHOR_BREAK_LOSS_PCT,
      anchorLossMinHoldMs:
        ANCHOR_LOSS_MIN_HOLD_MS,
      initialStopDistancePct,
      initialStopPrice:
        stopPrice
    };

    const trade: PaperTrade = {
      id:
        crypto.randomUUID(),
      symbol:
        signal.symbol,
      direction:
        signal.direction,
      status:
        "OPEN",
      openedAt:
        new Date(
          now
        ).toISOString(),
      entryPrice:
        round(
          entryPrice
        ),
      entryRef:
        signal.direction === "LONG"
          ? "ASK"
          : "BID",
      entryMexcBid:
        mexcBid,
      entryMexcAsk:
        mexcAsk,
      entryMexcBookSpreadPct:
        signal.mexcBookSpreadPct,
      qtyUsd:
        round(
          qtyUsd,
          2
        ),
      qtyToken:
        round(
          qtyToken,
          8
        ),
      depositAtEntry:
        round(
          depositAtEntry,
          4
        ),
      allocationPct:
        this.tradeAllocationPct,
      dexAnchorAtEntry:
        round(
          executableDexPrice
        ),
      dexSnapshotAtEntry:
        signal.dexUpdatedAt,
      entryAnchorAgeMs:
        signal.anchorAgeMs,
      entryAnchorIsFresh:
        Number.isFinite(
          signal.anchorAgeMs
        ) &&
        signal.anchorAgeMs <=
          config.maxDexAnchorAgeMs,
      entryMomentumPct:
        entryMomentumPct,
      entryMomentumBlocked:
        entryMomentumBlocked,
      entryMexcMid:
        entryMexcMid,
      entryNetEdgePct:
        signal.netEdgePct,
      entryDexDriftPct:
        signal.dexDriftPct,
      entryDexDirectionalDriftPct:
        signal.dexDirectionalDriftPct,
      entryDexTrendSlopePct:
        signal.dexTrendSlopePct ??
        0,
      maxEntryMexcBookSpreadPct:
        MAX_ENTRY_MEXC_BOOK_SPREAD_PCT,
      maxAnchorBreakLossPct:
        MAX_ANCHOR_BREAK_LOSS_PCT,
      entrySpreadPct:
        round(
          signal.spreadPct,
          4
        ),
      stopPrice:
        round(
          stopPrice
        ),
      stopDistancePct:
        round(
          initialStopDistancePct,
          4
        ),
      trailActive:
        false,
      trailBestPrice:
        round(
          entryPrice
        ),
      trailTriggerPct:
        this.getTrailingTriggerPct(),
      trailDistancePct:
        this.getTrailingDistancePct(),
      openReason:
        signal.reason
    };

    this.openTrades.set(
      positionKey,
      trade
    );

    this.liquidityAtEntry.set(
      positionKey,
      Number(
        signal.dexLiquidityUsd
      )
    );

    logger.warn(
      {
        id:
          trade.id,
        symbol:
          trade.symbol,
        direction:
          trade.direction,
        entryPrice:
          trade.entryPrice,
        entryMexcBid:
          trade.entryMexcBid,
        entryMexcAsk:
          trade.entryMexcAsk,
        entryMexcBookSpreadPct:
          trade.entryMexcBookSpreadPct,
        entryAnchorAgeMs:
          trade.entryAnchorAgeMs,
        entryAnchorIsFresh:
          trade.entryAnchorIsFresh,
        entryMomentumPct:
          trade.entryMomentumPct,
        entryMomentumBlocked:
          trade.entryMomentumBlocked,
        entryMexcMid:
          trade.entryMexcMid,
        entrySpreadPct:
          trade.entrySpreadPct,
        entryNetEdgePct:
          trade.entryNetEdgePct,
        entryDexDriftPct:
          trade.entryDexDriftPct,
        entryDexDirectionalDriftPct:
          trade.entryDexDirectionalDriftPct,
        entryDexTrendSlopePct:
          trade.entryDexTrendSlopePct,
        maxEntryMexcBookSpreadPct:
          trade.maxEntryMexcBookSpreadPct,
        maxAnchorBreakLossPct:
          trade.maxAnchorBreakLossPct,
        anchorLossMinHoldMs:
          ANCHOR_LOSS_MIN_HOLD_MS,
        dexAnchorAtEntry:
          trade.dexAnchorAtEntry,
        stopPrice:
          trade.stopPrice,
        stopDistancePct:
          trade.stopDistancePct,
        qtyUsd:
          trade.qtyUsd,
        qtyToken:
          trade.qtyToken,
        depositAtEntry:
          trade.depositAtEntry,
        trailTriggerPct:
          trade.trailTriggerPct,
        trailDistancePct:
          trade.trailDistancePct,
        minNetProfitPct:
          MIN_NET_PROFIT_PCT
      },
      "PAPER TRADE OPENED"
    );

    return {
      action:
        "OPEN",
      trade
    };
  }

  onTicker(
    ticker: MexcTicker,
    anchor: AnchorStatus | null
  ): PaperAction | null {
    const positionKey =
      normalizeSymbol(
        ticker.symbol
      );

    const trade =
      this.openTrades.get(
        positionKey
      );

    if (
      !trade ||
      this.processedCloseTrades.has(
        trade.id
      )
    ) {
      return null;
    }

    const now =
      Date.now();

    const openedAt =
      new Date(
        trade.openedAt
      ).getTime();

    const holdMs =
      Math.max(
        0,
        now - openedAt
      );

    const previousStopPrice =
      trade.stopPrice;

    const previousStopDistancePct =
      trade.stopDistancePct;

    this.updateTwoPhaseStop(
      trade,
      holdMs
    );

    const exitBid =
      Number(
        ticker.bid1
      );

    const exitAsk =
      Number(
        ticker.ask1
      );

    if (
      !isFinitePositive(
        exitBid
      ) ||
      !isFinitePositive(
        exitAsk
      ) ||
      exitAsk < exitBid
    ) {
      logger.warn(
        {
          symbol:
            ticker.symbol,
          tradeId:
            trade.id,
          exitBid,
          exitAsk
        },
        "Invalid paper exit book"
      );

      return null;
    }

    const exitMid =
      (
        exitBid +
        exitAsk
      ) / 2;

    const exitBookSpreadPct =
      isFinitePositive(
        exitMid
      )
        ? (
            (
              exitAsk -
              exitBid
            ) /
            exitMid
          ) * 100
        : undefined;

    const marketExitPrice =
      trade.direction === "LONG"
        ? exitBid
        : exitAsk;

    const marketGrossPnlPct =
      this.calculateGrossPnlPct(
        trade,
        marketExitPrice
      );

    const marketNetPnlPct =
      marketGrossPnlPct -
      this.getTotalCostsPct();

    const anchorLossTriggered =
      holdMs >=
        ANCHOR_LOSS_MIN_HOLD_MS &&
      marketNetPnlPct <=
        -MAX_ANCHOR_BREAK_LOSS_PCT;

    this.updateTrailingStop(
      trade,
      exitBid,
      exitAsk
    );

    const stopTriggered =
      this.isStopTriggered(
        trade,
        exitBid,
        exitAsk
      );

    const anchorIsFresh =
      anchor !== null &&
      Number.isFinite(
        anchor.anchorAgeMs
      ) &&
      anchor.anchorAgeMs <=
        config.maxDexAnchorAgeMs;

    let currentDexPrice:
      | number
      | undefined;

    let currentSpreadPct:
      | number
      | undefined;

    let anchorBroken =
      false;

    let dexMoveFromEntryPct:
      | number
      | undefined;

    if (
      anchor &&
      anchorIsFresh
    ) {
      const freshDexPrice =
        this.estimateExecutableDexPrice(
          anchor,
          trade.qtyUsd,
          trade.direction
        );

      if (
        isFinitePositive(
          freshDexPrice
        )
      ) {
        currentDexPrice =
          freshDexPrice;

        currentSpreadPct =
          trade.direction === "LONG"
            ? (
                (
                  freshDexPrice -
                  exitAsk
                ) /
                exitAsk
              ) * 100
            : (
                (
                  exitBid -
                  freshDexPrice
                ) /
                exitBid
              ) * 100;

        if (
          isFinitePositive(
            trade.dexAnchorAtEntry
          )
        ) {
          dexMoveFromEntryPct =
            (
              (
                freshDexPrice -
                trade.dexAnchorAtEntry
              ) /
              trade.dexAnchorAtEntry
            ) * 100;

          anchorBroken =
            this.isAnchorBroken(
              trade,
              freshDexPrice
            );
        }
      }
    } else if (
      anchor
    ) {
      //logger.debug(
      //  {
      //    symbol:
      //      ticker.symbol,
      //    tradeId:
      //      trade.id,
      //    anchorAgeMs:
      //      anchor.anchorAgeMs,
      //    maxAnchorAgeMs:
      //      config.maxDexAnchorAgeMs
      //  },
      //  "Stale DEX anchor ignored for open trade"
      //);
    }

    const spreadExitReached =
      currentSpreadPct !== undefined &&
      currentSpreadPct <=
        config.paperExitSpreadPct;

    const minHoldReached =
      holdMs >=
      this.getMinHoldMs();

    let closeReason:
      | CloseReason
      | null = null;

    let exitPrice =
      marketExitPrice;

    let stopTriggerPrice:
      | number
      | undefined;

    if (anchorBroken) {
      closeReason = "anchor_broken";
      exitPrice = marketExitPrice;

      logger.warn(
        {
          tradeId:
            trade.id,
          symbol:
            trade.symbol,
          direction:
            trade.direction,
          holdMs,
          anchorBroken,
          anchorLossTriggered,
          marketGrossPnlPct:
            round(
              marketGrossPnlPct,
              4
            ),
          marketNetPnlPct:
            round(
              marketNetPnlPct,
              4
            ),
          maxAnchorBreakLossPct:
            MAX_ANCHOR_BREAK_LOSS_PCT,
          anchorLossMinHoldMs:
            ANCHOR_LOSS_MIN_HOLD_MS,
          dexAnchorAtEntry:
            trade.dexAnchorAtEntry,
          currentDexPrice,
          dexMoveFromEntryPct,
          anchorAgeMs:
            anchor?.anchorAgeMs,
          anchorIsFresh
        },
        "Closing trade: DEX anchor movement protection triggered"
      );
    } else if (anchorLossTriggered) {
      closeReason = "anchor_loss";
      exitPrice = marketExitPrice;

      logger.warn(
        {
          tradeId:
            trade.id,
          symbol:
            trade.symbol,
          direction:
            trade.direction,
          holdMs,
          anchorBroken,
          anchorLossTriggered,
          marketGrossPnlPct:
            round(
              marketGrossPnlPct,
              4
            ),
          marketNetPnlPct:
            round(
              marketNetPnlPct,
              4
            ),
          maxAnchorBreakLossPct:
            MAX_ANCHOR_BREAK_LOSS_PCT,
          anchorLossMinHoldMs:
            ANCHOR_LOSS_MIN_HOLD_MS,
          dexAnchorAtEntry:
            trade.dexAnchorAtEntry,
          currentDexPrice,
          dexMoveFromEntryPct,
          anchorAgeMs:
            anchor?.anchorAgeMs,
          anchorIsFresh
        },
        "Closing trade: maximum loss protection triggered"
      );
    } else if (stopTriggered) {
      closeReason =
        trade.trailActive
          ? "trailing_stop"
          : "stop_loss";

      stopTriggerPrice =
        trade.direction === "LONG"
          ? exitBid
          : exitAsk;

      exitPrice =
        this.getStopExecutionPrice(
          trade
        );
    } else if (
      minHoldReached &&
      spreadExitReached
    ) {
      if (
        marketNetPnlPct >=
        MIN_NET_PROFIT_PCT
      ) {
        closeReason =
          "mean_reverted_profit";
      }
    } else if (
      minHoldReached &&
      holdMs >=
        config.paperMaxHoldMs
    ) {
      closeReason =
        "timeout";
    }

    if (
      !closeReason &&
      minHoldReached &&
      holdMs >=
        config.paperMaxHoldMs
    ) {
      closeReason =
        "timeout";
    }

    if (
      !closeReason
    ) {
      return null;
    }

    this.processedCloseTrades.add(
      trade.id
    );

    const grossPnlPct =
      this.calculateGrossPnlPct(
        trade,
        exitPrice
      );

    const totalCostsPct =
      this.getTotalCostsPct();

    const netPnlPct =
      grossPnlPct -
      totalCostsPct;

    const grossPnlUsd =
      trade.qtyUsd *
      grossPnlPct /
      100;

    const netPnlUsd =
      trade.qtyUsd *
      netPnlPct /
      100;

    if (
      !Number.isFinite(
        grossPnlPct
      ) ||
      !Number.isFinite(
        netPnlPct
      ) ||
      !Number.isFinite(
        grossPnlUsd
      ) ||
      !Number.isFinite(
        netPnlUsd
      )
    ) {
      this.processedCloseTrades.delete(
        trade.id
      );

      logger.error(
        {
          tradeId:
            trade.id,
          symbol:
            trade.symbol,
          grossPnlPct,
          netPnlPct,
          grossPnlUsd,
          netPnlUsd
        },
        "Invalid paper PnL"
      );

      return null;
    }

    const riskState =
      this.getSymbolRiskState(
        positionKey
      );

    if (
      closeReason ===
      "stop_loss"
    ) {
      riskState.consecutiveStops += 1;

      riskState.cooldownUntil =
        now +
        SYMBOL_STOP_COOLDOWN_MS;

      logger.warn(
        {
          symbol:
            trade.symbol,
          consecutiveStops:
            riskState.consecutiveStops,
          cooldownMin:
            SYMBOL_STOP_COOLDOWN_MS /
            60000
        },
        "Stop loss triggered: per-symbol cooldown activated"
      );

      if (
        riskState.consecutiveStops >=
        MAX_CONSECUTIVE_STOPS
      ) {
        riskState.bannedUntil =
          now +
          SYMBOL_BAN_DURATION_MS;

        logger.error(
          {
            symbol:
              trade.symbol,
            consecutiveStops:
              riskState.consecutiveStops,
            bannedHours:
              SYMBOL_BAN_DURATION_MS /
              3600000
          },
          "Consecutive stop loss limit reached: symbol temporarily banned"
        );
      }
    } else if (
      closeReason ===
        "mean_reverted_profit" ||
      closeReason ===
        "trailing_stop"
    ) {
      riskState.consecutiveStops = 0;
    }

    const depositBeforeClose =
      this.depositUsd;

    const depositAfterClose =
      Math.max(
        0,
        round(
          depositBeforeClose +
          netPnlUsd,
          4
        )
      );

    const closedTrade: PaperTrade = {
      ...trade,

      status:
        "CLOSED",

      closedAt:
        new Date(
          now
        ).toISOString(),

      exitPrice:
        round(
          exitPrice
        ),

      exitRef:
        trade.direction === "LONG"
          ? "BID"
          : "ASK",

      exitMexcBid:
        exitBid,

      exitMexcAsk:
        exitAsk,

      exitMexcBookSpreadPct:
        exitBookSpreadPct,

      dexAnchorAtExit:
        anchorIsFresh &&
        currentDexPrice !== undefined
          ? currentDexPrice
          : trade.dexAnchorAtEntry,

      dexSnapshotAtExit:
        anchorIsFresh
          ? anchor?.dexUpdatedAt
          : undefined,

      exitSpreadPct:
        currentSpreadPct !== undefined
          ? round(
              currentSpreadPct,
              4
            )
          : undefined,

      marketExitPrice:
        round(
          marketExitPrice
        ),

      marketGrossPnlPct:
        round(
          marketGrossPnlPct,
          4
        ),

      marketNetPnlPct:
        round(
          marketNetPnlPct,
          4
        ),

      anchorAgeMsAtExit:
        anchor?.anchorAgeMs,

      anchorIsFreshAtExit:
        anchorIsFresh,

      dexMoveFromEntryPct:
        dexMoveFromEntryPct !== undefined
          ? round(
              dexMoveFromEntryPct,
              4
            )
          : undefined,

      anchorBroken,

      anchorLossTriggered,

      stopPriceAtExit:
        trade.stopPrice,

      stopDistancePctAtExit:
        trade.stopDistancePct,

      grossPnlPct:
        round(
          grossPnlPct,
          4
        ),

      netPnlPct:
        round(
          netPnlPct,
          4
        ),

      grossPnlUsd:
        round(
          grossPnlUsd,
          4
        ),

      netPnlUsd:
        round(
          netPnlUsd,
          4
        ),

      depositAfterClose,

      holdMs,

      closeReason,

      stopTriggerPrice:
        stopTriggerPrice !== undefined
          ? round(
              stopTriggerPrice
            )
          : undefined,

      stopSlippagePct:
        closeReason ===
          "stop_loss" ||
        closeReason ===
          "trailing_stop"
          ? this.getStopSlippagePct()
          : undefined
    };

    this.depositUsd =
      depositAfterClose;

    this.openTrades.delete(
      positionKey
    );

    this.liquidityAtEntry.delete(
      positionKey
    );

    logger.warn(
      {
        tradeId:
          closedTrade.id,
        symbol:
          closedTrade.symbol,
        direction:
          closedTrade.direction,
        closeReason,
        holdMs,
        entry: {
          entryAnchorAgeMs:
            closedTrade.entryAnchorAgeMs,
          entryAnchorIsFresh:
            closedTrade.entryAnchorIsFresh,
          entryMomentumPct:
            closedTrade.entryMomentumPct,
          entryMomentumBlocked:
            closedTrade.entryMomentumBlocked,
          entryMexcBid:
            closedTrade.entryMexcBid,
          entryMexcAsk:
            closedTrade.entryMexcAsk,
          entryMexcMid:
            closedTrade.entryMexcMid,
          entryMexcBookSpreadPct:
            closedTrade.entryMexcBookSpreadPct,
          entrySpreadPct:
            closedTrade.entrySpreadPct,
          entryNetEdgePct:
            closedTrade.entryNetEdgePct,
          entryDexDriftPct:
            closedTrade.entryDexDriftPct,
          entryDexDirectionalDriftPct:
            closedTrade.entryDexDirectionalDriftPct,
          entryDexTrendSlopePct:
            closedTrade.entryDexTrendSlopePct,
          dexAnchorAtEntry:
            closedTrade.dexAnchorAtEntry
        },
        exit: {
          exitPrice:
            closedTrade.exitPrice,
          marketExitPrice:
            closedTrade.marketExitPrice,
          exitMexcBid:
            closedTrade.exitMexcBid,
          exitMexcAsk:
            closedTrade.exitMexcAsk,
          exitMexcBookSpreadPct:
            closedTrade.exitMexcBookSpreadPct,
          currentDexPrice,
          dexAnchorAtExit:
            closedTrade.dexAnchorAtExit,
          dexMoveFromEntryPct:
            closedTrade.dexMoveFromEntryPct,
          currentSpreadPct,
          anchorAgeMs:
            closedTrade.anchorAgeMsAtExit,
          anchorIsFresh:
            closedTrade.anchorIsFreshAtExit,
          anchorBroken:
            closedTrade.anchorBroken,
          anchorLossTriggered:
            closedTrade.anchorLossTriggered,
          marketGrossPnlPct:
            closedTrade.marketGrossPnlPct,
          marketNetPnlPct:
            closedTrade.marketNetPnlPct,
          maxAnchorBreakLossPct:
            MAX_ANCHOR_BREAK_LOSS_PCT,
          anchorLossMinHoldMs:
            ANCHOR_LOSS_MIN_HOLD_MS,
          stopPrice:
            closedTrade.stopPriceAtExit,
          stopDistancePct:
            closedTrade.stopDistancePctAtExit,
          stopTriggerPrice:
            closedTrade.stopTriggerPrice,
          previousStopPrice,
          previousStopDistancePct,
          currentStopDistancePct:
            closedTrade.stopDistancePct,
          trailActive:
            closedTrade.trailActive,
          trailBestPrice:
            closedTrade.trailBestPrice
        },
        pnl: {
          grossPnlPct:
            closedTrade.grossPnlPct,
          netPnlPct:
            closedTrade.netPnlPct,
          grossPnlUsd:
            closedTrade.grossPnlUsd,
          netPnlUsd:
            closedTrade.netPnlUsd,
          totalCostsPct
        },
        risk: {
          consecutiveStops:
            riskState.consecutiveStops,
          cooldownUntil:
            new Date(
              riskState.cooldownUntil
            ).toISOString(),
          bannedUntil:
            riskState.bannedUntil > now
              ? new Date(
                  riskState.bannedUntil
                ).toISOString()
              : undefined
        },
        depositBeforeClose,
        depositAfterClose,
        configuration: {
          maxEntrySpreadPct:
            MAX_ENTRY_SPREAD_PCT,
          maxEntryMexcBookSpreadPct:
            MAX_ENTRY_MEXC_BOOK_SPREAD_PCT,
          maxDexAnchorAgeMs:
            config.maxDexAnchorAgeMs,
          anchorBreakDistancePct:
            ANCHOR_BREAK_DISTANCE_PCT,
          maxAnchorBreakLossPct:
            MAX_ANCHOR_BREAK_LOSS_PCT,
          anchorLossMinHoldMs:
            ANCHOR_LOSS_MIN_HOLD_MS,
          initialStopDurationMs:
            INITIAL_STOP_DURATION_MS,
          initialStopDistancePct:
            INITIAL_STOP_DISTANCE_PCT,
          regularStopDistancePct:
            REGULAR_STOP_DISTANCE_PCT,
          entryMomentumWindowMs:
            ENTRY_MOMENTUM_WINDOW_MS,
          entryMomentumBlockPct:
            ENTRY_MOMENTUM_BLOCK_PCT,
          minNetProfitPct:
            MIN_NET_PROFIT_PCT
        }
      },
      "PAPER TRADE CLOSED"
    );

    return {
      action:
        "CLOSE",
      trade:
        closedTrade
    };
  }
}
