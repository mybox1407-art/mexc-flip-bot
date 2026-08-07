import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

import type {
  PaperTrade,
  FlipSignal,
  MexcTicker
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

function normalizeSymbol(value: string): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-\/\s]/g, "");
}

function round(
  value: number,
  digits = 6
): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class PaperExecutionService {
  private readonly openTrades = new Map<
    string,
    PaperTrade
  >();

  private readonly maxOpenTrades = 3;
  private readonly tradeAllocationPct = 0.3;

  private depositUsd = 100;

  getDepositUsd(): number {
    return round(this.depositUsd, 4);
  }

  getOpenTradesCount(): number {
    return this.openTrades.size;
  }

  onSignal(
    signal: FlipSignal
  ): PaperAction | null {
    const positionKey = normalizeSymbol(
      signal.symbol
    );

    const existing =
      this.openTrades.get(positionKey);

    if (existing) {
      logger.debug(
        {
          symbol: signal.symbol,
          positionKey,
          existingDirection:
            existing.direction,
          existingEntryPrice:
            existing.entryPrice,
          newDirection: signal.direction,
          newSpreadPct: signal.spreadPct,
          depositUsd: this.depositUsd
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
          symbol: signal.symbol,
          openTrades: this.openTrades.size,
          maxOpenTrades: this.maxOpenTrades,
          depositUsd: this.depositUsd
        },
        "Signal skipped: maximum open trades reached"
      );

      return null;
    }

    if (
      !Number.isFinite(this.depositUsd) ||
      this.depositUsd <= 0
    ) {
      logger.warn(
        {
          symbol: signal.symbol,
          depositUsd: this.depositUsd
        },
        "Signal skipped: deposit is empty"
      );

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
      logger.warn(
        {
          symbol: signal.symbol,
          direction: signal.direction,
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

    const qtyToken =
      qtyUsd / entryPrice;

    if (
      !Number.isFinite(qtyUsd) ||
      qtyUsd <= 0 ||
      !Number.isFinite(qtyToken) ||
      qtyToken <= 0
    ) {
      logger.warn(
        {
          symbol: signal.symbol,
          depositUsd: depositAtEntry,
          allocationPct:
            this.tradeAllocationPct,
          qtyUsd,
          entryPrice,
          qtyToken
        },
        "Invalid paper position size"
      );

      return null;
    }

    logger.info(
      {
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: entryPrice.toFixed(6),
        depositAtEntry,
        allocationPct:
          this.tradeAllocationPct,
        qtyUsd,
        qtyToken: qtyToken.toFixed(8),
        openTrades: this.openTrades.size,
        maxOpenTrades: this.maxOpenTrades,
        spreadPct: signal.spreadPct.toFixed(3),
        netEdgePct: signal.netEdgePct.toFixed(3),
        dexPrice: signal.dexPrice.toFixed(6),
        mexcBid: signal.mexcBid.toFixed(6),
        mexcAsk: signal.mexcAsk.toFixed(6),
        reason: signal.reason
      },
      "Opening paper trade"
    );

    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      symbol: signal.symbol,
      direction: signal.direction,
      status: "OPEN",

      openedAt: new Date().toISOString(),

      entryPrice: round(entryPrice),

      entryRef:
        signal.direction === "LONG"
          ? "ASK"
          : "BID",

      qtyUsd: round(qtyUsd, 2),
      qtyToken: round(qtyToken, 8),

      depositAtEntry: round(
        depositAtEntry,
        4
      ),

      allocationPct:
        this.tradeAllocationPct,

      dexAnchorAtEntry: round(
        signal.dexPrice
      ),

      entrySpreadPct: round(
        signal.spreadPct,
        4
      ),

      openReason: signal.reason
    };

    this.openTrades.set(
      positionKey,
      trade
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
        openTrades: this.openTrades.size,
        entrySpreadPct:
          trade.entrySpreadPct
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
    const positionKey = normalizeSymbol(
      ticker.symbol
    );

    const trade =
      this.openTrades.get(positionKey);

    if (!trade) {
      return null;
    }

    if (!anchor) {
      logger.debug(
        {
          symbol: ticker.symbol,
          tradeDirection: trade.direction,
          entryPrice: trade.entryPrice,
          depositUsd: this.depositUsd
        },
        "Trade check skipped: no DEX anchor"
      );

      return null;
    }

    const now = Date.now();

    const openedAt =
      new Date(trade.openedAt).getTime();

    const holdMs = Math.max(
      0,
      now - openedAt
    );

    const holdSec = Math.floor(
      holdMs / 1000
    );

    const spreadPct =
      trade.direction === "LONG"
        ? anchor.longSpreadPct
        : anchor.shortSpreadPct;

    if (
      !Number.isFinite(spreadPct)
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          tradeId: trade.id,
          spreadPct
        },
        "Invalid exit spread"
      );

      return null;
    }

    const currentPrice =
      Number(ticker.lastPrice);

    logger.debug(
      {
        symbol: ticker.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        currentPrice: Number.isFinite(
          currentPrice
        )
          ? currentPrice.toFixed(6)
          : "invalid",
        spreadPct: spreadPct.toFixed(3),
        holdSec,
        exitThreshold:
          config.paperExitSpreadPct,
        stopThreshold:
          config.paperStopSpreadPct,
        maxHoldSec: Math.floor(
          config.paperMaxHoldMs / 1000
        ),
        depositUsd: this.depositUsd
      },
      "Checking open position"
    );

    let shouldClose = false;
    let closeReason = "";

    // Сначала проверяем стоп-лосс.
    // Иначе отрицательный spread попадёт
    // в условие mean_reverted.
    if (
      spreadPct <=
      -config.paperStopSpreadPct
    ) {
      shouldClose = true;
      closeReason = "stop_loss";
    } else if (
      spreadPct >= 0 &&
      spreadPct <=
      config.paperExitSpreadPct
    ) {
      shouldClose = true;
      closeReason = "mean_reverted";
    } else if (
      holdMs >= config.paperMaxHoldMs
    ) {
      shouldClose = true;
      closeReason = "timeout";
    }

    if (!shouldClose) {
      return null;
    }

    const exitPrice =
      trade.direction === "LONG"
        ? anchor.mexcBid
        : anchor.mexcAsk;

    if (
      !Number.isFinite(exitPrice) ||
      exitPrice <= 0
    ) {
      logger.warn(
        {
          symbol: ticker.symbol,
          tradeId: trade.id,
          exitPrice
        },
        "Invalid paper exit price"
      );

      return null;
    }

    const grossPnlPct =
      trade.direction === "LONG"
        ? (
            (exitPrice - trade.entryPrice) /
            trade.entryPrice
          ) * 100
        : (
            (trade.entryPrice - exitPrice) /
            trade.entryPrice
          ) * 100;

    // Учитываются только расходы MEXC.
    // DEX используется только как reference price.
    const totalCostsPct =
      config.assumedFeesPct +
      config.assumedSlippagePct;

    const netPnlPct =
      grossPnlPct -
      totalCostsPct;

    const grossPnlUsd =
      (trade.qtyUsd * grossPnlPct) /
      100;

    const netPnlUsd =
      (trade.qtyUsd * netPnlPct) /
      100;

    if (
      !Number.isFinite(netPnlUsd)
    ) {
      logger.error(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          grossPnlPct,
          netPnlPct,
          grossPnlUsd,
          netPnlUsd
        },
        "Invalid paper PnL"
      );

      return null;
    }

    const depositBeforeClose =
      this.depositUsd;

    const depositAfterClose = Math.max(
      0,
      round(
        depositBeforeClose + netPnlUsd,
        4
      )
    );

    logger.warn(
      {
        id: trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        exitPrice: exitPrice.toFixed(6),
        grossPnlPct: grossPnlPct.toFixed(4),
        netPnlPct: netPnlPct.toFixed(4),
        grossPnlUsd: grossPnlUsd.toFixed(4),
        netPnlUsd: netPnlUsd.toFixed(4),
        depositBeforeClose,
        depositAfterClose,
        holdSec,
        closeReason,
        entrySpreadPct: trade.entrySpreadPct,
        exitSpreadPct: spreadPct.toFixed(3)
      },
      "Closing paper trade"
    );

    const closedTrade: PaperTrade = {
      ...trade,

      status: "CLOSED",

      closedAt: new Date(now).toISOString(),

      exitPrice: round(exitPrice),

      exitRef:
        trade.direction === "LONG"
          ? "BID"
          : "ASK",

      dexAnchorAtExit: round(
        anchor.dexPrice
      ),

      exitSpreadPct: round(
        spreadPct,
        4
      ),

      grossPnlPct: round(
        grossPnlPct,
        4
      ),

      netPnlPct: round(
        netPnlPct,
        4
      ),

      grossPnlUsd: round(
        grossPnlUsd,
        4
      ),

      netPnlUsd: round(
        netPnlUsd,
        4
      ),

      depositAfterClose,

      holdMs,
      closeReason
    };

    // Депозит изменяется только после закрытия сделки.
    this.depositUsd =
      depositAfterClose;

    this.openTrades.delete(
      positionKey
    );

    logger.warn(
      {
        id: closedTrade.id,
        symbol: closedTrade.symbol,
        direction: closedTrade.direction,
        entryPrice: closedTrade.entryPrice,
        exitPrice: closedTrade.exitPrice,
        grossPnlPct:
          closedTrade.grossPnlPct?.toFixed(4),
        netPnlPct:
          closedTrade.netPnlPct?.toFixed(4),
        grossPnlUsd:
          closedTrade.grossPnlUsd?.toFixed(4),
        netPnlUsd:
          closedTrade.netPnlUsd?.toFixed(4),
        depositAtEntry:
          closedTrade.depositAtEntry,
        depositAfterClose:
          closedTrade.depositAfterClose,
        openTrades: this.openTrades.size,
        holdSec,
        closeReason: closedTrade.closeReason
      },
      "PAPER TRADE CLOSED"
    );

    return {
      action: "CLOSE",
      trade: closedTrade
    };
  }
}
