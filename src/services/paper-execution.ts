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
  return Math.round(value * factor) / factor;
}

export class PaperExecutionService {
  private readonly openTrades =
    new Map<string, PaperTrade>();

  private readonly processedCloseTrades =
    new Set<string>();

  private readonly liquidityAtEntry =
    new Map<string, number>();

  private readonly maxOpenTrades = 3;

  // 0.3 = 30% депозита.
  private readonly tradeAllocationPct = 0.3;

  private depositUsd = 100;

  getDepositUsd(): number {
    return round(this.depositUsd, 4);
  }

  getOpenTradesCount(): number {
    return this.openTrades.size;
  }

  private getTotalCostsPct(): number {
    return (
      config.mexcEntryFeePct +
      config.mexcExitFeePct +
      config.mexcEntrySlippagePct +
      config.mexcExitSlippagePct +
      config.latencyBufferPct
    );
  }

  private estimateExecutableDexPrice(
    anchor: AnchorStatus,
    qtyUsd: number,
    direction: "LONG" | "SHORT"
  ): number {
    if (
      !Number.isFinite(anchor.dexPrice) ||
      anchor.dexPrice <= 0 ||
      !Number.isFinite(
        anchor.dexLiquidityUsd
      ) ||
      anchor.dexLiquidityUsd <= 0 ||
      !Number.isFinite(qtyUsd) ||
      qtyUsd <= 0
    ) {
      return NaN;
    }

    const estimatedImpactPct =
      Math.min(
        (qtyUsd /
          anchor.dexLiquidityUsd) *
          100,
        config.paperMaxDexPriceImpactPct
      );

    if (direction === "LONG") {
      return (
        anchor.dexPrice *
        (1 + estimatedImpactPct / 100)
      );
    }

    return (
      anchor.dexPrice *
      (1 - estimatedImpactPct / 100)
    );
  }

  onSignal(
    signal: FlipSignal
  ): PaperAction | null {
    const positionKey =
      normalizeSymbol(signal.symbol);

    if (
      this.openTrades.has(positionKey)
    ) {
      return null;
    }

    if (
      this.openTrades.size >=
      this.maxOpenTrades
    ) {
      return null;
    }

    if (
      !Number.isFinite(this.depositUsd) ||
      this.depositUsd <= 0
    ) {
      return null;
    }

    const entryPrice =
      signal.direction === "LONG"
        ? signal.mexcAsk
        : signal.mexcBid;

    if (
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0
    ) {
      return null;
    }

    const depositAtEntry =
      this.depositUsd;

    const qtyUsd =
      depositAtEntry *
      this.tradeAllocationPct;

    const qtyToken =
      qtyUsd / entryPrice;

    if (
      !Number.isFinite(qtyUsd) ||
      qtyUsd <= 0 ||
      !Number.isFinite(qtyToken) ||
      qtyToken <= 0
    ) {
      return null;
    }

    const anchor: AnchorStatus = {
      symbol: signal.symbol,
      dexPrice: signal.dexPrice,
      dexLiquidityUsd:
        signal.dexLiquidityUsd,
      dexVolumeM5:
        signal.dexVolumeM5,
      dexBuysM5:
        signal.dexBuysM5,
      dexSellsM5:
        signal.dexSellsM5,
      dexId: signal.dexId,
      chainId: signal.chainId,
      quoteSymbol: signal.quoteSymbol,
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
      mexcBid:
        signal.mexcBid,
      mexcAsk:
        signal.mexcAsk,
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
      !Number.isFinite(
        executableDexPrice
      ) ||
      executableDexPrice <= 0
    ) {
      return null;
    }

    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      symbol: signal.symbol,
      direction: signal.direction,
      status: "OPEN",

      openedAt:
        new Date().toISOString(),

      entryPrice: round(entryPrice),

      entryRef:
        signal.direction === "LONG"
          ? "ASK"
          : "BID",

      qtyUsd: round(qtyUsd, 2),
      qtyToken: round(qtyToken, 8),

      depositAtEntry:
        round(depositAtEntry, 4),

      allocationPct:
        this.tradeAllocationPct,

      dexAnchorAtEntry:
        round(executableDexPrice),

      dexSnapshotAtEntry:
        signal.dexUpdatedAt,

      entrySpreadPct:
        round(signal.spreadPct, 4),

      openReason:
        signal.reason
    };

    this.openTrades.set(
      positionKey,
      trade
    );

    this.liquidityAtEntry.set(
      positionKey,
      signal.dexLiquidityUsd
    );

    logger.warn(
      {
        id: trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        qtyUsd: trade.qtyUsd,
        qtyToken: trade.qtyToken,
        depositAtEntry:
          trade.depositAtEntry,
        allocationPct:
          trade.allocationPct,
        dexAnchorAtEntry:
          trade.dexAnchorAtEntry
      },
      "PAPER TRADE OPENED"
    );

    return {
      action: "OPEN",
      trade
    };
  }

  onTicker(
    ticker: MexcTicker,
    anchor: AnchorStatus | null
  ): PaperAction | null {
    const positionKey =
      normalizeSymbol(ticker.symbol);

    const trade =
      this.openTrades.get(positionKey);

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

    const now = Date.now();

    const openedAt =
      new Date(trade.openedAt)
        .getTime();

    const holdMs = Math.max(
      0,
      now - openedAt
    );

    const exitPrice =
      trade.direction === "LONG"
        ? Number(ticker.bid1)
        : Number(ticker.ask1);

    if (
      !Number.isFinite(exitPrice) ||
      exitPrice <= 0
    ) {
      return null;
    }

    const grossPnlPct =
      trade.direction === "LONG"
        ? (
            (exitPrice -
              trade.entryPrice) /
            trade.entryPrice
          ) * 100
        : (
            (trade.entryPrice -
              exitPrice) /
            trade.entryPrice
          ) * 100;

    const totalCostsPct =
      this.getTotalCostsPct();

    const netPnlPct =
      grossPnlPct - totalCostsPct;

    const grossPnlUsd =
      (trade.qtyUsd *
        grossPnlPct) /
      100;

    const netPnlUsd =
      (trade.qtyUsd *
        netPnlPct) /
      100;

    if (
      !Number.isFinite(netPnlPct) ||
      !Number.isFinite(netPnlUsd)
    ) {
      return null;
    }

    let closeReason:
      | CloseReason
      | null = null;

    let currentDexPrice:
      | number
      | undefined;

    let currentSpreadPct:
      | number
      | undefined;

    if (anchor) {
      currentDexPrice =
        this.estimateExecutableDexPrice(
          anchor,
          trade.qtyUsd,
          trade.direction
        );

      if (
        Number.isFinite(
          currentDexPrice
        ) &&
        currentDexPrice > 0
      ) {
        const anchorMovePct =
          (
            (currentDexPrice -
              trade.dexAnchorAtEntry) /
            trade.dexAnchorAtEntry
          ) * 100;

        const movedAgainst =
          trade.direction === "LONG"
            ? anchorMovePct <=
              -config.paperMaxAnchorMoveAgainstPct
            : anchorMovePct >=
              config.paperMaxAnchorMoveAgainstPct;

        if (movedAgainst) {
          closeReason =
            "anchor_moved_against_position";
        }

        currentSpreadPct =
          trade.direction === "LONG"
            ? (
                (currentDexPrice -
                  anchor.mexcAsk) /
                anchor.mexcAsk
              ) * 100
            : (
                (anchor.mexcBid -
                  currentDexPrice) /
                anchor.mexcBid
              ) * 100;
      }

      const entryLiquidity =
        this.liquidityAtEntry.get(
          positionKey
        );

      if (
        entryLiquidity &&
        entryLiquidity > 0
      ) {
        const liquidityDropPct =
          (
            (entryLiquidity -
              anchor.dexLiquidityUsd) /
            entryLiquidity
          ) * 100;

        if (
          liquidityDropPct >=
          config.paperMaxLiquidityDropPct
        ) {
          closeReason =
            "liquidity_drop";
        }
      }

      if (
        anchor.anchorAgeMs >
        config.maxDexAnchorAgeMs
      ) {
        closeReason =
          "anchor_stale";
      }
    }

    if (
      netPnlPct <=
      -config.paperStopLossPct
    ) {
      closeReason = "stop_loss";
    } else if (
      !closeReason &&
      currentSpreadPct !== undefined &&
      currentSpreadPct <=
        config.paperExitSpreadPct
    ) {
      closeReason =
        netPnlPct > 0
          ? "mean_reverted_profit"
          : "mean_reverted_loss";
    } else if (
      !closeReason &&
      holdMs >= config.paperMaxHoldMs
    ) {
      closeReason = "timeout";
    }

    if (!closeReason) {
      return null;
    }

    this.processedCloseTrades.add(
      trade.id
    );

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

      status: "CLOSED",

      closedAt:
        new Date(now).toISOString(),

      exitPrice: round(exitPrice),

      exitRef:
        trade.direction === "LONG"
          ? "BID"
          : "ASK",

      dexAnchorAtExit:
        currentDexPrice ??
        trade.dexAnchorAtEntry,

      dexSnapshotAtExit:
        anchor?.dexUpdatedAt,

      exitSpreadPct:
        currentSpreadPct !== undefined
          ? round(currentSpreadPct, 4)
          : undefined,

      grossPnlPct:
        round(grossPnlPct, 4),

      netPnlPct:
        round(netPnlPct, 4),

      grossPnlUsd:
        round(grossPnlUsd, 4),

      netPnlUsd:
        round(netPnlUsd, 4),

      depositAfterClose,
      holdMs,
      closeReason
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
        id: closedTrade.id,
        symbol: closedTrade.symbol,
        direction: closedTrade.direction,
        entryPrice:
          closedTrade.entryPrice,
        exitPrice:
          closedTrade.exitPrice,
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
        closeReason
      },
      "PAPER TRADE CLOSED"
    );

    return {
      action: "CLOSE",
      trade: closedTrade
    };
  }
}
