import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { PaperTrade, FlipSignal, MexcTicker } from "../types.js";
import type { AnchorStatus } from "./spread-engine.js";

type PaperAction =
  | {
      action: "OPEN";
      trade: PaperTrade;
    }
  | {
      action: "CLOSE";
      trade: PaperTrade;
    };

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class PaperExecutionService {
  private readonly openTrades = new Map<string, PaperTrade>();

  onSignal(signal: FlipSignal): PaperAction | null {
    // Проверка: уже есть позиция
    if (this.openTrades.has(signal.symbol)) {
      const existing = this.openTrades.get(signal.symbol)!;
      logger.debug(
        {
          symbol: signal.symbol,
          existingDirection: existing.direction,
          existingEntryPrice: existing.entryPrice,
          newDirection: signal.direction,
          newSpreadPct: signal.spreadPct
        },
        "Signal skipped: position already open"
      );
      return null;
    }

    const entryPrice = signal.direction === "LONG" ? signal.mexcAsk : signal.mexcBid;
    const qtyUsd = config.paperTradeUsdSize;
    const qtyToken = qtyUsd / entryPrice;

    logger.info(
      {
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: entryPrice.toFixed(6),
        qtyUsd: qtyUsd,
        qtyToken: qtyToken.toFixed(8),
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
      entryRef: signal.direction === "LONG" ? "ASK" : "BID",
      qtyUsd: round(qtyUsd, 2),
      qtyToken: round(qtyToken, 8),
      dexAnchorAtEntry: round(signal.dexPrice),
      entrySpreadPct: round(signal.spreadPct, 4),
      openReason: signal.reason
    };

    this.openTrades.set(signal.symbol, trade);

    logger.warn(
      {
        id: trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        qtyUsd: trade.qtyUsd,
        qtyToken: trade.qtyToken,
        entrySpreadPct: trade.entrySpreadPct
      },
      "PAPER TRADE OPENED"
    );

    return {
      action: "OPEN",
      trade
    };
  }

  onTicker(ticker: MexcTicker, anchor: AnchorStatus | null): PaperAction | null {
    const trade = this.openTrades.get(ticker.symbol);
    
    if (!trade) {
      return null;
    }

    if (!anchor) {
      logger.debug(
        {
          symbol: ticker.symbol,
          tradeDirection: trade.direction,
          entryPrice: trade.entryPrice
        },
        "Trade check skipped: no DEX anchor"
      );
      return null;
    }

    const now = Date.now();
    const openedAt = new Date(trade.openedAt).getTime();
    const holdMs = now - openedAt;
    const holdSec = Math.floor(holdMs / 1000);

    const spreadPct =
      trade.direction === "LONG" ? anchor.longSpreadPct : anchor.shortSpreadPct;

    logger.debug(
      {
        symbol: ticker.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        currentPrice: ticker.lastPrice.toFixed(6),
        spreadPct: spreadPct.toFixed(3),
        holdSec: holdSec,
        exitThreshold: config.paperExitSpreadPct,
        stopThreshold: config.paperStopSpreadPct,
        maxHoldSec: Math.floor(config.paperMaxHoldMs / 1000)
      },
      "Checking open position"
    );

    let shouldClose = false;
    let closeReason = "";

    if (spreadPct <= config.paperExitSpreadPct) {
      shouldClose = true;
      closeReason = "mean_reverted";
    } else if (spreadPct <= -config.paperStopSpreadPct) {
      shouldClose = true;
      closeReason = "stop_loss";
    } else if (holdMs >= config.paperMaxHoldMs) {
      shouldClose = true;
      closeReason = "timeout";
    }

    if (!shouldClose) {
      return null;
    }

    const exitPrice = trade.direction === "LONG" ? anchor.mexcBid : anchor.mexcAsk;
    const grossPnlPct =
      trade.direction === "LONG"
        ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;

    const totalCostsPct = config.assumedFeesPct + config.assumedSlippagePct;
    const netPnlPct = grossPnlPct - totalCostsPct;

    const grossPnlUsd = (trade.qtyUsd * grossPnlPct) / 100;
    const netPnlUsd = (trade.qtyUsd * netPnlPct) / 100;

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
        holdSec: holdSec,
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
      exitRef: trade.direction === "LONG" ? "BID" : "ASK",
      dexAnchorAtExit: round(anchor.dexPrice),
      exitSpreadPct: round(spreadPct, 4),
      grossPnlPct: round(grossPnlPct, 4),
      netPnlPct: round(netPnlPct, 4),
      grossPnlUsd: round(grossPnlUsd, 4),
      netPnlUsd: round(netPnlUsd, 4),
      holdMs,
      closeReason
    };

    this.openTrades.delete(ticker.symbol);

    logger.warn(
      {
        id: closedTrade.id,
        symbol: closedTrade.symbol,
        direction: closedTrade.direction,
        entryPrice: closedTrade.entryPrice,
        exitPrice: closedTrade.exitPrice,
        netPnlPct: closedTrade.netPnlPct!.toFixed(4),  // ← Добавь !
        netPnlUsd: closedTrade.netPnlUsd!.toFixed(4),  // ← Добавь !
        holdSec: holdSec,
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
