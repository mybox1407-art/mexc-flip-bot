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

/**
 * Максимально допустимый входной спред.
 * Все что выше — битый маппинг или чужой токен.
 */
const MAX_ENTRY_SPREAD_PCT = 4.5;

/**
 * Минимальная net-прибыль после round-trip издержек
 * для закрытия по возврату спреда.
 */
const MIN_NET_PROFIT_PCT = 0.05;

/**
 * Кулдаун на инструмент после срабатывания stop_loss.
 */
const SYMBOL_STOP_COOLDOWN_MS =
  15 * 60 * 1000;

/**
 * Лимит стопов подряд до временного бана инструмента.
 */
const MAX_CONSECUTIVE_STOPS = 2;

/**
 * Длительность бана инструмента при серии стопов.
 */
const SYMBOL_BAN_DURATION_MS =
  2 * 60 * 60 * 1000;

/**
 * Двухфазный стоп.
 *
 * Первые 30 секунд:
 *   LONG  — стоп ниже входа на 0.40%
 *   SHORT — стоп выше входа на 0.40%
 *
 * После 30 секунд:
 *   LONG  — стоп ниже входа на 1.5%
 *   SHORT — стоп выше входа на 1.5%
 */
const INITIAL_STOP_DURATION_MS =
  30 * 1000;

const INITIAL_STOP_DISTANCE_PCT =
  0.40;

const REGULAR_STOP_DISTANCE_PCT =
  1.5;

/**
 * Допустимое движение DEX-якоря против торгового тезиса.
 *
 * LONG:
 *   DEX должен быть выше MEXC.
 *   Если DEX упал относительно якоря против позиции на 0.40%,
 *   закрываем сделку немедленно.
 *
 * SHORT:
 *   DEX должен быть ниже MEXC.
 *   Если DEX вырос относительно якоря против позиции на 0.40%,
 *   закрываем сделку немедленно.
 */
const ANCHOR_BREAK_DISTANCE_PCT =
  0.40;

/**
 * Перед входом запрещаем сделку, если MEXC
 * уже движется против направления арбитража.
 *
 * SHORT:
 *   mid вырос >= 0.15% за последние 30 секунд
 *   => не входить
 *
 * LONG:
 *   mid упал >= 0.15% за последние 30 секунд
 *   => не входить
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
  bid: number;
  ask: number;
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
  const factor = 10 ** digits;

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

  /**
   * История mid MEXC по символу.
   * Нужна, чтобы не входить в уже идущий импульс.
   */
  private readonly priceHistory =
    new Map<string, PriceSample[]>();

  private readonly maxOpenTrades = 3;

  private readonly tradeAllocationPct = 0.3;

  private depositUsd = 100;

  getDepositUsd(): number {
    return round(
      this.depositUsd,
      4
    );
  }

  getOpenTradesCount(): number {
    return this.openTrades.size;
  }

  private getTotalCostsPct(): number {
    return config.roundTripCostPct;
  }

  private getUsedCapitalUsd(): number {
    let usedCapitalUsd = 0;

    for (
      const trade of this.openTrades.values()
    ) {
      usedCapitalUsd += trade.qtyUsd;
    }

    return usedCapitalUsd;
  }

  private getMaxTotalExposureUsd(): number {
    return (
      this.depositUsd *
      config.paperMaxTotalExposurePct
    );
  }

  /**
   * Возвращает актуальную дистанцию стопа
   * с учетом времени удержания позиции.
   */
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
      !isFinitePositive(
        bid
      ) ||
      !isFinitePositive(
        ask
      ) ||
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
      !isFinitePositive(
        mid
      )
    ) {
      return;
    }

    let samples =
      this.priceHistory.get(
        positionKey
      );

    if (
      !samples
    ) {
      samples = [];

      this.priceHistory.set(
        positionKey,
        samples
      );
    }

    const lastSample =
      samples[
        samples.length - 1
      ];

    if (
      !lastSample ||
      lastSample.timestamp !==
        timestamp
    ) {
      samples.push({
        timestamp,
        mid,
        bid,
        ask
      });
    }

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

  /**
   * Возвращает изменение mid MEXC за окно
   * ENTRY_MOMENTUM_WINDOW_MS.
   *
   * null — недостаточно истории.
   */
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

    const targetTs =
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
            targetTs
        ) <
          Math.abs(
            reference.timestamp -
              targetTs
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
        latest.mid
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

  /**
   * Обновляет динамический двухфазный стоп.
   *
   * Первые 30 секунд стоп равен 0.40%.
   * После 30 секунд стоп становится 1.5%.
   *
   * Если трейлинг уже поднял/опустил стоп,
   * стоп не расширяется обратно.
   */
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
          exitPrice -
          trade.entryPrice
        ) /
        trade.entryPrice
      ) * 100;
    }

    return (
      (
        trade.entryPrice -
        exitPrice
      ) /
      trade.entryPrice
    ) * 100;
  }

  /**
   * Проверяет поломку DEX-якоря относительно
   * исходного DEX-якоря сделки.
   *
   * Важный момент:
   * сравниваем именно DEX с DEX, а не текущий спред MEXC/DEX.
   * Это предотвращает закрытие только из-за движения MEXC.
   */
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

  /**
   * Обновление трейлинг-стопа.
   */
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

    const stopPrice =
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

      trade.trailActive = true;

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
          stopPrice
        ) ||
        (
          trade.direction === "LONG"
            ? newStopPrice >
              stopPrice
            : newStopPrice <
              stopPrice
        )
      ) {
        trade.stopPrice =
          round(
            newStopPrice
          );
      }

      logger.debug(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          direction: trade.direction,
          movePct: round(
            movePct,
            4
          ),
          triggerPct,
          distancePct,
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
            stopPrice
          ) ||
          newStopPrice >
            stopPrice
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
          stopPrice
        ) ||
        newStopPrice <
          stopPrice
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
      const remainingMin =
        Math.ceil(
          (
            riskState.bannedUntil -
            now
          ) / 60000
        );

      logger.debug(
        {
          symbol:
            signal.symbol,

          bannedUntil:
            new Date(
              riskState.bannedUntil
            ).toISOString(),

          remainingMin
        },
        "Signal skipped: symbol is temporarily banned due to consecutive stop losses"
      );

      return null;
    }

    if (
      now <
      riskState.cooldownUntil
    ) {
      const remainingSec =
        Math.ceil(
          (
            riskState.cooldownUntil -
            now
          ) / 1000
        );

      logger.debug(
        {
          symbol:
            signal.symbol,

          cooldownUntil:
            new Date(
              riskState.cooldownUntil
            ).toISOString(),

          remainingSec
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

          spreadPct:
            round(
              signal.spreadPct,
              3
            ),

          maxEntrySpreadPct:
            MAX_ENTRY_SPREAD_PCT
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

    this.recordPriceSample(
      positionKey,
      mexcBid,
      mexcAsk,
      now
    );

    const momentumPct =
      this.getMomentumPct(
        positionKey,
        now
      );

    if (
      momentumPct ===
      null
    ) {
      logger.debug(
        {
          symbol:
            signal.symbol,

          direction:
            signal.direction
        },
        "Entry momentum filter skipped: insufficient MEXC price history"
      );
    } else if (
      this.isMomentumAgainstPosition(
        signal.direction,
        momentumPct
      )
    ) {
      logger.warn(
        {
          symbol:
            signal.symbol,

          direction:
            signal.direction,

          momentumPct:
            round(
              momentumPct,
              4
            ),

          blockPct:
            ENTRY_MOMENTUM_BLOCK_PCT,

          windowMs:
            ENTRY_MOMENTUM_WINDOW_MS
        },
        "Signal skipped: MEXC momentum is moving against the intended position"
      );

      return null;
    }

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
        new Date().toISOString(),

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

        qtyUsd:
          trade.qtyUsd,

        qtyToken:
          trade.qtyToken,

        depositAtEntry:
          trade.depositAtEntry,

        allocationPct:
          trade.allocationPct,

        dexAnchorAtEntry:
          trade.dexAnchorAtEntry,

        entrySpreadPct:
          trade.entrySpreadPct,

        stopPrice:
          trade.stopPrice,

        stopDistancePct:
          trade.stopDistancePct,

        initialStopDurationMs:
          INITIAL_STOP_DURATION_MS,

        initialStopDistancePct:
          INITIAL_STOP_DISTANCE_PCT,

        regularStopDistancePct:
          REGULAR_STOP_DISTANCE_PCT,

        anchorBreakDistancePct:
          ANCHOR_BREAK_DISTANCE_PCT,

        entryMomentumPct:
          momentumPct ===
          null
            ? undefined
            : round(
                momentumPct,
                4
              ),

        entryMomentumBlockPct:
          ENTRY_MOMENTUM_BLOCK_PCT,

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

    const now =
      Date.now();

    const tickerBid =
      Number(
        ticker.bid1
      );

    const tickerAsk =
      Number(
        ticker.ask1
      );

    this.recordPriceSample(
      positionKey,
      tickerBid,
      tickerAsk,
      Number.isFinite(
        ticker.timestamp
      )
        ? ticker.timestamp
        : now
    );

    const trade =
      this.openTrades.get(
        positionKey
      );

    if (
      !trade
    ) {
      return null;
    }

    if (
      this.processedCloseTrades.has(
        trade.id
      )
    ) {
      return null;
    }

    const openedAt =
      new Date(
        trade.openedAt
      ).getTime();

    const holdMs =
      Math.max(
        0,
        now - openedAt
      );

    /**
     * Переключение двухфазного стопа:
     * до 30 секунд — 0.40%,
     * после 30 секунд — 1.5%.
     */
    const previousStopDistancePct =
      trade.stopDistancePct;

    this.updateTwoPhaseStop(
      trade,
      holdMs
    );

    if (
      previousStopDistancePct !==
      trade.stopDistancePct
    ) {
      logger.debug(
        {
          tradeId:
            trade.id,

          symbol:
            trade.symbol,

          direction:
            trade.direction,

          holdMs,

          previousStopDistancePct,

          currentStopDistancePct:
            trade.stopDistancePct,

          stopPrice:
            trade.stopPrice
        },
        "Two-phase stop updated"
      );
    }

    const exitBid =
      tickerBid;

    const exitAsk =
      tickerAsk;

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

          if (
            anchorBroken
          ) {
            logger.warn(
              {
                tradeId:
                  trade.id,

                symbol:
                  trade.symbol,

                direction:
                  trade.direction,

                dexAnchorAtEntry:
                  trade.dexAnchorAtEntry,

                currentDexPrice:
                  freshDexPrice,

                dexMoveFromEntryPct:
                  round(
                    dexMoveFromEntryPct,
                    4
                  ),

                anchorBreakDistancePct:
                  ANCHOR_BREAK_DISTANCE_PCT
              },
              "DEX ANCHOR BROKEN"
            );
          }
        }
      }

      const entryLiquidity =
        this.liquidityAtEntry.get(
          positionKey
        );

      const currentLiquidity =
        Number(
          anchor.dexLiquidityUsd
        );

      if (
        isFinitePositive(
          entryLiquidity
        ) &&
        isFinitePositive(
          currentLiquidity
        )
      ) {
        const liquidityDropPct =
          (
            (
              entryLiquidity -
              currentLiquidity
            ) /
            entryLiquidity
          ) * 100;

        if (
          liquidityDropPct >=
          config.paperMaxLiquidityDropPct
        ) {
          logger.debug(
            {
              symbol:
                ticker.symbol,

              tradeId:
                trade.id,

              entryLiquidity,

              currentLiquidity,

              liquidityDropPct
            },
            "Paper liquidity drop detected"
          );
        }
      }
    } else if (
      anchor
    ) {
      logger.debug(
        {
          symbol:
            ticker.symbol,

          tradeId:
            trade.id,

          anchorAgeMs:
            anchor.anchorAgeMs,

          maxAnchorAgeMs:
            config.maxDexAnchorAgeMs
        },
        "Stale DEX anchor ignored for open trade"
      );
    }

    const spreadExitReached =
      currentSpreadPct !==
        undefined &&
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

    /**
     * Приоритет выхода:
     *
     * 1. Поломка DEX-якоря — немедленный выход.
     * 2. Двухфазный/трейлинг-стоп.
     * 3. Возврат спреда с минимальной net-прибылью.
     * 4. Timeout.
     */
    if (
      anchorBroken
    ) {
      closeReason =
        "anchor_broken";

      exitPrice =
        marketExitPrice;

      logger.warn(
        {
          tradeId:
            trade.id,

          symbol:
            trade.symbol,

          direction:
            trade.direction,

          dexAnchorAtEntry:
            trade.dexAnchorAtEntry,

          currentDexPrice,

          dexMoveFromEntryPct,

          anchorBreakDistancePct:
            ANCHOR_BREAK_DISTANCE_PCT,

          marketExitPrice
        },
        "Closing trade: DEX anchor moved against thesis"
      );
    } else if (
      stopTriggered
    ) {
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
      const grossPnlPctAtMarket =
        this.calculateGrossPnlPct(
          trade,
          marketExitPrice
        );

      const netPnlPctAtMarket =
        grossPnlPctAtMarket -
        this.getTotalCostsPct();

      if (
        netPnlPctAtMarket >=
        MIN_NET_PROFIT_PCT
      ) {
        closeReason =
          "mean_reverted_profit";

        logger.debug(
          {
            tradeId:
              trade.id,

            symbol:
              trade.symbol,

            currentSpreadPct,

            grossPnlPct:
              round(
                grossPnlPctAtMarket,
                4
              ),

            netPnlPct:
              round(
                netPnlPctAtMarket,
                4
              ),

            minNetProfitPct:
              MIN_NET_PROFIT_PCT
          },
          "Minimum net profit reached"
        );
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
        currentDexPrice !==
          undefined
          ? currentDexPrice
          : trade.dexAnchorAtEntry,

      dexSnapshotAtExit:
        anchorIsFresh
          ? anchor?.dexUpdatedAt
          : undefined,

      exitSpreadPct:
        currentSpreadPct !==
          undefined
          ? round(
              currentSpreadPct,
              4
            )
          : undefined,

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
        stopTriggerPrice !==
          undefined
          ? round(
              stopTriggerPrice
            )
          : undefined,

      marketExitPrice:
        round(
          marketExitPrice
        ),

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
        id:
          closedTrade.id,

        symbol:
          closedTrade.symbol,

        direction:
          closedTrade.direction,

        entryPrice:
          closedTrade.entryPrice,

        entryMexcBid:
          closedTrade.entryMexcBid,

        entryMexcAsk:
          closedTrade.entryMexcAsk,

        exitPrice:
          closedTrade.exitPrice,

        marketExitPrice:
          closedTrade.marketExitPrice,

        stopPrice:
          closedTrade.stopPrice,

        stopDistancePct:
          closedTrade.stopDistancePct,

        stopTriggerPrice:
          closedTrade.stopTriggerPrice,

        exitMexcBid:
          closedTrade.exitMexcBid,

        exitMexcAsk:
          closedTrade.exitMexcAsk,

        grossPnlPct:
          closedTrade.grossPnlPct,

        netPnlPct:
          closedTrade.netPnlPct,

        grossPnlUsd:
          closedTrade.grossPnlUsd,

        netPnlUsd:
          closedTrade.netPnlUsd,

        depositAtEntry:
          closedTrade.depositAtEntry,

        depositBeforeClose,

        depositAfterClose,

        holdMs,

        currentSpreadPct,

        dexAnchorAtEntry:
          closedTrade.dexAnchorAtEntry,

        dexAnchorAtExit:
          closedTrade.dexAnchorAtExit,

        dexMoveFromEntryPct,

        anchorBreakDistancePct:
          ANCHOR_BREAK_DISTANCE_PCT,

        anchorAgeMs:
          anchor?.anchorAgeMs,

        anchorIsFresh,

        closeReason,

        minNetProfitPct:
          MIN_NET_PROFIT_PCT,

        trailActive:
          closedTrade.trailActive,

        trailBestPrice:
          closedTrade.trailBestPrice
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
