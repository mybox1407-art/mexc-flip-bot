import { config } from "../config.js";
import { logger } from "../logger.js";
import type { PaperTrade } from "../types.js";

function formatNumber(
  value: number | undefined,
  digits = 4
): string {
  if (
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "-";
  }

  return value.toFixed(digits);
}

function formatSignedNumber(
  value: number | undefined,
  digits = 4
): string {
  if (
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "-";
  }

  const formatted =
    value.toFixed(digits);

  return value > 0
    ? `+${formatted}`
    : formatted;
}

function formatHoldMs(
  ms?: number
): string {
  if (
    ms === undefined ||
    !Number.isFinite(ms) ||
    ms <= 0
  ) {
    return "0s";
  }

  const totalSeconds =
    Math.floor(ms / 1000);

  const hours =
    Math.floor(totalSeconds / 3600);

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    );

  const seconds =
    totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatSamaraDateTime(
  value?: string | number | Date
): string {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return "-";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "-";
  }

  const formatted =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone: "Europe/Samara",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    ).format(date);

  return `${formatted.replace(",", "")} Samara`;
}

export class TelegramNotifier {
  constructor(
    private readonly token?: string,
    private readonly chatId?: string
  ) {}

  get enabled(): boolean {
    return Boolean(
      this.token &&
      this.chatId
    );
  }

  private async send(
    text: string
  ): Promise<void> {
    if (!this.enabled) {
      logger.info(
        "Telegram notifier disabled"
      );

      return;
    }

    try {
      const response =
        await fetch(
          `https://api.telegram.org/bot${this.token}/sendMessage`,
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json"
            },
            body: JSON.stringify({
              chat_id: this.chatId,
              text,
              disable_web_page_preview:
                true
            })
          }
        );

      if (!response.ok) {
        const body =
          await response.text();

        logger.warn(
          {
            status:
              response.status,
            body
          },
          "Telegram sendMessage failed"
        );
      }
    } catch (error) {
      logger.warn(
        {
          err: error
        },
        "Telegram sendMessage error"
      );
    }
  }

  async sendStartup(): Promise<void> {
    const text = [
      "BOT STARTED",
      `Time: ${formatSamaraDateTime(
        new Date()
      )}`
    ].join("\n");

    await this.send(text);
  }

  async sendTradeOpened(
    trade: PaperTrade
  ): Promise<void> {
    const stopLossPct =
      Number(
        config.paperStopLossPct
      );

    const stopLossUsd =
      Number.isFinite(stopLossPct) &&
      Number.isFinite(trade.qtyUsd) &&
      trade.qtyUsd > 0
        ? trade.qtyUsd *
          stopLossPct /
          100
        : undefined;

    const stopLossText =
      stopLossUsd !== undefined
        ? `-${stopLossUsd.toFixed(4)} USD`
        : "-";

    const text = [
      "OPEN",
      `Symbol: ${trade.symbol}`,
      `Direction: ${trade.direction}`,
      `Entry price: ${formatNumber(
        trade.entryPrice,
        8
      )}`,
      `Entry ref: ${trade.entryRef}`,
      `Size USD: ${formatNumber(
        trade.qtyUsd,
        2
      )}`,
      `Qty token: ${formatNumber(
        trade.qtyToken,
        8
      )}`,
      `DEX anchor entry: ${formatNumber(
        trade.dexAnchorAtEntry,
        8
      )}`,
      `Entry spread: ${formatNumber(
        trade.entrySpreadPct,
        4
      )}%`,
      `Stop-loss amount: ${stopLossText}`,
      `Opened at: ${formatSamaraDateTime(
        trade.openedAt
      )}`,
      `Reason: ${trade.openReason}`
    ].join("\n");

    await this.send(text);
  }

  async sendTradeClosed(
    trade: PaperTrade
  ): Promise<void> {
    const text = [
      "CLOSE",
      `Symbol: ${trade.symbol}`,
      `Direction: ${trade.direction}`,
      `Entry price: ${formatNumber(
        trade.entryPrice,
        8
      )}`,
      `Exit price: ${formatNumber(
        trade.exitPrice,
        8
      )}`,
      `Entry ref: ${trade.entryRef}`,
      `Exit ref: ${trade.exitRef ?? "-"}`,
      `Size USD: ${formatNumber(
        trade.qtyUsd,
        2
      )}`,
      `Qty token: ${formatNumber(
        trade.qtyToken,
        8
      )}`,
      `DEX anchor entry: ${formatNumber(
        trade.dexAnchorAtEntry,
        8
      )}`,
      `DEX anchor exit: ${formatNumber(
        trade.dexAnchorAtExit,
        8
      )}`,
      `Entry spread: ${formatNumber(
        trade.entrySpreadPct,
        4
      )}%`,
      `Exit spread: ${formatNumber(
        trade.exitSpreadPct,
        4
      )}%`,
      `Gross PnL USD: ${formatSignedNumber(
        trade.grossPnlUsd,
        4
      )}`,
      `Gross PnL %: ${formatSignedNumber(
        trade.grossPnlPct,
        4
      )}%`,
      `Net PnL USD: ${formatSignedNumber(
        trade.netPnlUsd,
        4
      )}`,
      `Net PnL %: ${formatSignedNumber(
        trade.netPnlPct,
        4
      )}%`,
      `Final balance: ${formatNumber(
        trade.depositAfterClose,
        4
      )} USD`,
      `Opened at: ${formatSamaraDateTime(
        trade.openedAt
      )}`,
      `Closed at: ${formatSamaraDateTime(
        trade.closedAt
      )}`,
      `Hold: ${formatHoldMs(
        trade.holdMs
      )}`,
      `Close reason: ${
        trade.closeReason ?? "-"
      }`
    ].join("\n");

    await this.send(text);
  }
}
