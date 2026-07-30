import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { MexcTicker } from "../types.js";

type JsonRecord = Record<string, unknown>;

interface MexcWsHandlers {
  onTicker: (ticker: MexcTicker) => void;
  onDeal: (symbol: string, payload: JsonRecord) => void;
  onDepth: (symbol: string, payload: JsonRecord) => void;
  onConnected?: () => void;
}

export class MexcFuturesWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  private readonly subscribedDeals = new Set<string>();
  private readonly subscribedDepths = new Set<string>();

  constructor(private readonly handlers: MexcWsHandlers) {}

  connect(): void {
    this.stopped = false;
    this.openConnection();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.ws?.close();
    this.ws = null;
  }

  subscribeDeals(symbol: string): void {
    this.subscribedDeals.add(symbol);
    this.sendSubscription("sub.deal", { symbol });
  }

  subscribeDepth(symbol: string): void {
    this.subscribedDepths.add(symbol);
    this.sendSubscription("sub.depth", { symbol });
  }

  private openConnection(): void {
    logger.info({ url: config.mexcWsUrl }, "Connecting to MEXC Futures WebSocket");

    this.ws = new WebSocket(config.mexcWsUrl);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      logger.info("MEXC Futures WebSocket connected");

      this.send({
        method: "sub.tickers",
        param: {},
        gzip: false
      });

      for (const symbol of this.subscribedDeals) {
        this.sendSubscription("sub.deal", { symbol });
      }

      for (const symbol of this.subscribedDepths) {
        this.sendSubscription("sub.depth", { symbol });
      }

      this.handlers.onConnected?.();
    });

    this.ws.on("message", (raw) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on("error", (error) => {
      logger.warn({ err: error }, "MEXC Futures WebSocket error");
    });

    this.ws.on("close", (code, reason) => {
      logger.warn(
        { code, reason: reason.toString() },
        "MEXC Futures WebSocket closed"
      );

      this.ws = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;

    logger.info({ delay }, "Scheduling MEXC WebSocket reconnect");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delay);
  }

  private sendSubscription(method: string, param: JsonRecord): void {
    this.send({ method, param, gzip: false });
  }

  private send(payload: JsonRecord): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let message: JsonRecord;

    try {
      message = JSON.parse(raw) as JsonRecord;
    } catch {
      logger.warn({ raw }, "Could not parse MEXC WebSocket message");
      return;
    }

    const channel = String(message.channel ?? "");
    const data = message.data as JsonRecord | JsonRecord[] | undefined;

    if (channel === "push.tickers" && Array.isArray(data)) {
      for (const row of data) {
        const ticker = this.toTicker(row);

        if (ticker) {
          this.handlers.onTicker(ticker);
        }
      }
      return;
    }

    const symbol = String(message.symbol ?? "");

    if (channel === "push.deal" && data && !Array.isArray(data) && symbol) {
      this.handlers.onDeal(symbol, data);
      return;
    }

    if (channel === "push.depth" && data && !Array.isArray(data) && symbol) {
      this.handlers.onDepth(symbol, data);
    }
  }

  private toTicker(row: JsonRecord): MexcTicker | null {
    const symbol = String(row.symbol ?? "");

    if (!symbol) {
      return null;
    }

    return {
      symbol,
      timestamp: Number(row.timestamp ?? Date.now()),
      lastPrice: Number(row.lastPrice ?? 0),
      volume24: Number(row.volume24 ?? 0),
      amount24: Number(row.amount24 ?? 0),
      riseFallRate: Number(row.riseFallRate ?? 0),
      fairPrice: Number(row.fairPrice ?? 0),
      indexPrice: Number(row.indexPrice ?? 0),
      maxBidPrice: Number(row.maxBidPrice ?? 0),
      minAskPrice: Number(row.minAskPrice ?? 0),
      lower24Price: Number(row.lower24Price ?? 0),
      high24Price: Number(row.high24Price ?? 0)
    };
  }
}
