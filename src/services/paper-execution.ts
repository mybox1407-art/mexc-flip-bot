import crypto from "node:crypto";
import { config } from "../config.js";
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
    if (this.openTrades.has(signal.symbol)) {
      return null;
    }

    const entryPrice = signal.direction === "LONG" ? signal.mexcAsk : signal.mexcBid;
    const qtyUsd = config.paperTradeUsdSize;
    const qtyToken = qtyUsd / entryPrice;

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

    return {
      action: "OPEN",
      trade
    };
  }

  onTicker(ticker: MexcTicker, anchor: AnchorStatus | null): PaperAction | null {
    const trade = this.openTrades.get(ticker.symbol);
    if (!trade || !anchor) {
      return null;
    }

    const now = Date.now();
    const openedAt = new Date(trade.openedAt).getTime();
    const holdMs = now - openedAt;

    const spreadPct =
      trade.direction === "LONG" ? anchor.longSpreadPct : anchor.shortSpreadPct;

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

    return {
      action: "CLOSE",
      trade: closedTrade
    };
  }
}
