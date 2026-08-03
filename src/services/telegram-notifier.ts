import { logger } from "../logger.js";
import type { PaperTrade } from "../types.js";

function formatNumber(value: number | undefined, digits = 4): string {
  if (value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return value.toFixed(digits);
}

function formatSignedNumber(value: number | undefined, digits = 4): string {
  if (value === undefined || Number.isNaN(value)) {
    return "-";
  }

  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatHoldMs(ms?: number): string {
  if (!ms || ms <= 0) {
    return "0s";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export class TelegramNotifier {
  constructor(
    private readonly token?: string,
    private readonly chatId?: string
  ) {}

  get enabled(): boolean {
    return Boolean(this.token && this.chatId);
  }

  private async send(text: string): Promise<void> {
    if (!this.enabled) {
      logger.info("Telegram notifier disabled");
      return;
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          disable_web_page_preview: true
        })
      });

      if (!response.ok) {
        const body = await response.text();
        logger.warn({ status: response.status, body }, "Telegram sendMessage failed");
      }
    } catch (error) {
      logger.warn({ err: error }, "Telegram sendMessage error");
    }
  }

  async sendStartup(): Promise<void> {
    const text = [
      "BOT STARTED",
      `Time: ${new Date().toISOString()}`
    ].join("\n");

    await this.send(text);
  }

  async sendTradeOpened(trade: PaperTrade): Promise<void> {
    const text = [
      "OPEN",
      `Symbol: ${trade.symbol}`,
      `Direction: ${trade.direction}`,
      `Entry price: ${formatNumber(trade.entryPrice, 8)}`,
      `Entry ref: ${trade.entryRef}`,
      `Size USD: ${formatNumber(trade.qtyUsd, 2)}`,
      `Qty token: ${formatNumber(trade.qtyToken, 8)}`,
      `DEX anchor entry: ${formatNumber(trade.dexAnchorAtEntry, 8)}`,
      `Entry spread: ${formatNumber(trade.entrySpreadPct, 4)}%`,
      `Opened at: ${trade.openedAt}`,
      `Reason: ${trade.openReason}`
    ].join("\n");

    await this.send(text);
  }

  async sendTradeClosed(trade: PaperTrade): Promise<void> {
    const text = [
      "CLOSE",
      `Symbol: ${trade.symbol}`,
      `Direction: ${trade.direction}`,
      `Entry price: ${formatNumber(trade.entryPrice, 8)}`,
      `Exit price: ${formatNumber(trade.exitPrice, 8)}`,
      `Entry ref: ${trade.entryRef}`,
      `Exit ref: ${trade.exitRef ?? "-"}`,
      `Size USD: ${formatNumber(trade.qtyUsd, 2)}`,
      `Qty token: ${formatNumber(trade.qtyToken, 8)}`,
      `DEX anchor entry: ${formatNumber(trade.dexAnchorAtEntry, 8)}`,
      `DEX anchor exit: ${formatNumber(trade.dexAnchorAtExit, 8)}`,
      `Entry spread: ${formatNumber(trade.entrySpreadPct, 4)}%`,
      `Exit spread: ${formatNumber(trade.exitSpreadPct, 4)}%`,
      `Gross PnL USD: ${formatSignedNumber(trade.grossPnlUsd, 4)}`,
      `Gross PnL %: ${formatSignedNumber(trade.grossPnlPct, 4)}%`,
      `Net PnL USD: ${formatSignedNumber(trade.netPnlUsd, 4)}`,
      `Net PnL %: ${formatSignedNumber(trade.netPnlPct, 4)}%`,
      `Opened at: ${trade.openedAt}`,
      `Closed at: ${trade.closedAt ?? "-"}`,
      `Hold: ${formatHoldMs(trade.holdMs)}`,
      `Close reason: ${trade.closeReason ?? "-"}`
    ].join("\n");

    await this.send(text);
  }
}
