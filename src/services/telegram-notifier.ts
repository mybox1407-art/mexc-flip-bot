import type { PaperTrade } from "../types.js";

export class TelegramNotifier {
  constructor(
    private readonly token?: string,
    private readonly chatId?: string
  ) {}

  private get enabled(): boolean {
    return Boolean(this.token && this.chatId);
  }

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn("Telegram send failed", res.status, body);
    }
  }

  async sendTradeOpened(trade: PaperTrade): Promise<void> {
    const text = [
      "🟢 OPEN",
      `${trade.symbol} ${trade.direction}`,
      `Entry: ${trade.entryPrice}`,
      `Size: ${trade.qtyUsd} USD`,
      `Qty: ${trade.qtyToken}`,
      `Spread: ${trade.entrySpreadPct.toFixed(2)}%`,
      `Ref: ${trade.entryRef}`,
      `Time: ${trade.openedAt}`,
      `Reason: ${trade.openReason}`
    ].join("\n");

    await this.send(text);
  }

  async sendTradeClosed(trade: PaperTrade): Promise<void> {
    const text = [
      "🔴 CLOSE",
      `${trade.symbol} ${trade.direction}`,
      `Entry: ${trade.entryPrice}`,
      `Exit: ${trade.exitPrice ?? "-"}`,
      `Gross PnL: ${trade.grossPnlUsd?.toFixed(2) ?? "-"} USD (${trade.grossPnlPct?.toFixed(2) ?? "-"}%)`,
      `Net PnL: ${trade.netPnlUsd?.toFixed(2) ?? "-"} USD (${trade.netPnlPct?.toFixed(2) ?? "-"}%)`,
      `Hold: ${trade.holdMs ?? 0} ms`,
      `Exit ref: ${trade.exitRef ?? "-"}`,
      `Time: ${trade.closedAt ?? "-"}`,
      `Reason: ${trade.closeReason ?? "-"}`
    ].join("\n");

    await this.send(text);
  }
}
