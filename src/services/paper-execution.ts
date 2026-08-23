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

interface SymbolRiskState {
  consecutiveStops: number;
  cooldownUntil: number;
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

  private getStopDistancePct(
    holdMs: number
  ): number {
    if (
      holdMs <
      config.paperInitialStopWindowMs
    ) {
      return config.paperInitialStopLossPct;
    }

    return config.paperStopLossPct;
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
        cooldownUntil: 0
      };

      this.symbolRisk.set(
        positionKey,
        state
      );
    }

    return state;
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
      return exitBid <= stopPrice;
    }

    return exitAsk >= stopPrice;
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
              (
                currentPrice -
                trade.entryPrice
              ) /
              trade.entryPrice
            ) * 100
          )
        : (
            (
              (
                trade.entryPrice -
                currentPrice
              ) /
              trade.entryPrice
            ) * 100
          );

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
          round(newStopPrice);
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
            round(newStopPrice);
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
          round(newStopPrice);
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
          spreadPct: round(
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

    const stopDistancePct =
      this.getStopDistancePct(0);

    const stopPrice =
      this.calculateStopPrice(
        entryPrice,
        signal.direction,
        stopDistancePct
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
        round(entryPrice),

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
        round(stopPrice),

      stopDistancePct:
        round(
          stopDistancePct,
          4
        ),

      trailActive:
        false,

      trailBestPrice:
        round(entryPrice),

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

    if (!trade) {
      return null;
    }

    if (
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
      isFinitePositive(exitMid)
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

    /**
     * Фаза 1: 0.4% до 20 секунд.
     * Затем основной стоп из PAPER_STOP_LOSS_PCT.
     * Активный трейлинг не ослабляем.
     */
    const activeStopDistancePct =
      this.getStopDistancePct(
        holdMs
      );

    if (!trade.trailActive) {
      trade.stopDistancePct =
        round(
          activeStopDistancePct,
          4
        );

      trade.stopPrice =
        round(
          this.calculateStopPrice(
            trade.entryPrice,
            trade.direction,
            activeStopDistancePct
          )
        );
    }

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
    } else if (anchor) {
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

    /**
     * Поломка якоря.
     *
     * LONG: DEX упал сильнее MEXC.
     * SHORT: DEX вырос сильнее MEXC.
     *
     * Работает только по свежему DEX snapshot.
     */
    let anchorMovedAgainstPosition =
      false;

    let dexMovePct:
      | number
      | undefined;

    let mexcMovePct:
      | number
      | undefined;

    let relativeMovePct:
      | number
      | undefined;

    if (
      anchorIsFresh &&
      isFinitePositive(
        currentDexPrice
      ) &&
      isFinitePositive(
        trade.dexAnchorAtEntry
      ) &&
      isFinitePositive(
        marketExitPrice
      ) &&
      isFinitePositive(
        trade.entryPrice
      )
    ) {
      dexMovePct =
        (
          (
            currentDexPrice -
            trade.dexAnchorAtEntry
          ) /
          trade.dexAnchorAtEntry
        ) * 100;

      mexcMovePct =
        (
          (
            marketExitPrice -
            trade.entryPrice
          ) /
          trade.entryPrice
        ) * 100;

      relativeMovePct =
        trade.direction === "LONG"
          ? mexcMovePct -
            dexMovePct
          : dexMovePct -
            mexcMovePct;

      anchorMovedAgainstPosition =
        relativeMovePct >=
        config.paperAnchorBreakPct;

      if (
        anchorMovedAgainstPosition
      ) {
        logger.warn(
          {
            tradeId:
              trade.id,
            symbol:
              trade.symbol,
            direction:
              trade.direction,
            dexMovePct: round(
              dexMovePct,
              4
            ),
            mexcMovePct: round(
              mexcMovePct,
              4
            ),
            relativeMovePct: round(
              relativeMovePct,
              4
            ),
            thresholdPct:
              config.paperAnchorBreakPct,
            anchorAgeMs:
              anchor?.anchorAgeMs
          },
          "DEX anchor moved against paper position"
        );
      }
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

    if (stopTriggered) {
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
      anchorMovedAgainstPosition
    ) {
      closeReason =
        "anchor_moved_against_position";

      exitPrice =
        marketExitPrice;
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
            grossPnlPct: round(
              grossPnlPctAtMarket,
              4
            ),
            netPnlPct: round(
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

    if (!closeReason) {
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

    /**
     * Считаем только стопы после 20 секунд.
     * Ранние 0.4% стопы не банят и не считаются
     * в consecutiveStops.
     */
    const isMatureStop =
      closeReason === "stop_loss" &&
      holdMs >=
        config.paperInitialStopWindowMs;

    if (isMatureStop) {
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
            60000,
          holdMs
        },
        "Mature stop loss triggered: per-symbol cooldown activated"
      );
    } else if (
      closeReason === "stop_loss"
    ) {
      logger.debug(
        {
          symbol:
            trade.symbol,
          holdMs,
          initialStopWindowMs:
            config.paperInitialStopWindowMs
        },
        "Early stop loss (<20s): cooldown only, no ban"
      );

      riskState.cooldownUntil =
        now +
        SYMBOL_STOP_COOLDOWN_MS;
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
        round(exitPrice),

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
        dexMovePct,
        mexcMovePct,
        relativeMovePct,
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
