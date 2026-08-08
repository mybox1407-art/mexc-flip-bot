import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { MexcTicker } from "../types.js";

type JsonRecord =
  Record<string, unknown>;

interface MexcWsHandlers {
  onTicker: (
    ticker: MexcTicker
  ) => void;

  onDeal: (
    symbol: string,
    payload: JsonRecord
  ) => void;

  onDepth: (
    symbol: string,
    payload: JsonRecord
  ) => void;

  onConnected?: () => void;
}

export class MexcFuturesWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer:
    NodeJS.Timeout | null = null;

  private reconnectAttempt = 0;
  private stopped = false;

  private pingTimer:
    NodeJS.Timeout | null = null;

  private firstTickerLogged = false;
  private pingCount = 0;
  private tickerCount = 0;

  private connectionOpenedAt = 0;

  private readonly subscribedDeals =
    new Set<string>();

  private readonly subscribedDepths =
    new Set<string>();

  private readonly subscribedTickers =
    new Set<string>();

  constructor(
    private readonly handlers: MexcWsHandlers
  ) {}

  connect(): void {
    this.stopped = false;
    this.openConnection();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(
        this.reconnectTimer
      );

      this.reconnectTimer = null;
    }

    this.stopPing();

    this.ws?.close();
    this.ws = null;
  }

  subscribeDeals(
    symbol: string
  ): void {
    this.subscribedDeals.add(
      symbol
    );

    this.sendSubscription(
      "sub.deal",
      { symbol }
    );
  }

  subscribeDepth(
    symbol: string
  ): void {
    this.subscribedDepths.add(
      symbol
    );

    this.sendSubscription(
      "sub.depth",
      { symbol }
    );
  }

  private subscribeTicker(
    symbol: string
  ): void {
    if (
      this.subscribedTickers.has(
        symbol
      )
    ) {
      return;
    }

    this.subscribedTickers.add(
      symbol
    );

    this.send({
      method: "sub.ticker",
      param: { symbol },
      gzip: false
    });

    logger.info(
      { symbol },
      "Subscribed to push.ticker"
    );
  }

  private openConnection(): void {
    logger.info(
      {
        url: config.mexcWsUrl
      },
      "Connecting to MEXC Futures WebSocket"
    );

    this.connectionOpenedAt =
      Date.now();

    this.ws =
      new WebSocket(
        config.mexcWsUrl
      );

    this.ws.on(
      "open",
      () => {
        this.reconnectAttempt = 0;

        logger.info(
          "MEXC Futures WebSocket connected"
        );

        this.startPing();

        this.send({
          method: "sub.tickers",
          param: {},
          gzip: false
        });

        for (
          const symbol
          of this.subscribedDeals
        ) {
          this.sendSubscription(
            "sub.deal",
            { symbol }
          );
        }

        for (
          const symbol
          of this.subscribedDepths
        ) {
          this.sendSubscription(
            "sub.depth",
            { symbol }
          );
        }

        this.handlers.onConnected?.();
      }
    );

    this.ws.on(
      "message",
      (raw) => {
        this.handleMessage(
          raw.toString()
        );
      }
    );

    this.ws.on(
      "error",
      (error) => {
        logger.warn(
          { err: error },
          "MEXC Futures WebSocket error"
        );
      }
    );

    this.ws.on(
      "close",
      (code, reason) => {
        logger.warn(
          {
            code,
            reason:
              reason.toString()
          },
          "MEXC Futures WebSocket closed"
        );

        this.ws = null;
        this.scheduleReconnect();
      }
    );
  }

  private startPing(): void {
    if (this.pingTimer) {
      clearInterval(
        this.pingTimer
      );
    }

    this.pingTimer =
      setInterval(
        () => {
          if (
            this.ws?.readyState ===
            WebSocket.OPEN
          ) {
            this.send({
              method: "ping"
            });

            this.pingCount += 1;

            logger.info(
              {
                count:
                  this.pingCount
              },
              "Ping sent"
            );
          }
        },
        30_000
      );

    setTimeout(
      () => {
        if (
          this.ws?.readyState ===
          WebSocket.OPEN
        ) {
          logger.info(
            "Forced reconnect: 23h TTL reached"
          );

          this.ws.close();
        }
      },
      23 * 60 * 60 * 1000
    );
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(
        this.pingTimer
      );

      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.reconnectTimer
    ) {
      return;
    }

    const delay =
      Math.min(
        30_000,
        1_000 *
          2 ** this.reconnectAttempt
      );

    this.reconnectAttempt += 1;

    logger.info(
      { delay },
      "Scheduling MEXC WebSocket reconnect"
    );

    this.reconnectTimer =
      setTimeout(
        () => {
          this.reconnectTimer =
            null;

          this.openConnection();
        },
        delay
      );
  }

  private sendSubscription(
    method: string,
    param: JsonRecord
  ): void {
    this.send({
      method,
      param,
      gzip: false
    });
  }

  private send(
    payload: JsonRecord
  ): void {
    if (
      this.ws?.readyState !==
      WebSocket.OPEN
    ) {
      return;
    }

    this.ws.send(
      JSON.stringify(payload)
    );
  }

  private handleMessage(
    raw: string
  ): void {
    let message: JsonRecord;

    try {
      message =
        JSON.parse(raw) as JsonRecord;
    } catch {
      logger.warn(
        { raw },
        "Could not parse MEXC WebSocket message"
      );

      return;
    }

    const channel =
      String(
        message.channel ?? ""
      );

    const data =
      message.data as
        | JsonRecord
        | JsonRecord[]
        | undefined;

    if (
      channel === "pong"
    ) {
      logger.debug(
        "Received pong from MEXC"
      );

      return;
    }

    if (
      channel === "rs.sub.tickers"
    ) {
      logger.info(
        "MEXC tickers subscription confirmed"
      );

      return;
    }

    if (
      channel === "rs.sub.ticker"
    ) {
      const param =
        message.param as
          | JsonRecord
          | undefined;

      const symbol =
        String(
          param?.symbol ?? ""
        );

      logger.info(
        { symbol },
        "MEXC push.ticker subscription confirmed"
      );

      return;
    }

    if (
      channel === "push.tickers" &&
      Array.isArray(data)
    ) {
      for (
        const row of data
      ) {
        const ticker =
          this.toTicker(row);

        if (!ticker) {
          continue;
        }

        this.subscribeTicker(
          ticker.symbol
        );

        this.tickerCount += 1;

        if (
          this.tickerCount % 1000 ===
          0
        ) {
          logger.info(
            {
              count:
                this.tickerCount,

              symbol:
                ticker.symbol
            },
            "Tickers processed"
          );
        }

        if (
          !this.firstTickerLogged
        ) {
          logger.info(
            {
              symbol:
                ticker.symbol,

              price:
                ticker.lastPrice,

              bid1:
                ticker.bid1,

              ask1:
                ticker.ask1
            },
            "First ticker received"
          );

          this.firstTickerLogged =
            true;
        }

        this.handlers.onTicker(
          ticker
        );
      }

      return;
    }

    if (
      channel === "push.ticker" &&
      data &&
      !Array.isArray(data)
    ) {
      const ticker =
        this.tickerFromPushTicker(
          data
        );

      if (ticker) {
        this.handlers.onTicker(
          ticker
        );
      }

      return;
    }

    const symbol =
      String(
        message.symbol ?? ""
      );

    if (
      channel === "push.deal" &&
      data &&
      !Array.isArray(data) &&
      symbol
    ) {
      this.handlers.onDeal(
        symbol,
        data
      );

      return;
    }

    if (
      channel === "push.depth" &&
      data &&
      !Array.isArray(data) &&
      symbol
    ) {
      this.handlers.onDepth(
        symbol,
        data
      );
    }
  }

  private toTicker(
    row: JsonRecord
  ): MexcTicker | null {
    const symbol =
      String(row.symbol ?? "");

    if (!symbol) {
      return null;
    }

    const lastPrice =
      Number(row.lastPrice ?? 0);

    const bid1 =
      Number(row.bid1 ?? 0);

    const ask1 =
      Number(row.ask1 ?? 0);

    if (
      !Number.isFinite(lastPrice) ||
      lastPrice <= 0
    ) {
      logger.warn(
        {
          symbol,
          lastPrice,
          rawLastPrice:
            row.lastPrice
        },
        "Invalid MEXC ticker last price"
      );

      return null;
    }

    if (
      !Number.isFinite(bid1) ||
      bid1 <= 0 ||
      !Number.isFinite(ask1) ||
      ask1 <= 0 ||
      ask1 < bid1
    ) {
      logger.warn(
        {
          symbol,
          lastPrice,
          rawBid1:
            row.bid1,
          rawAsk1:
            row.ask1,
          bid1,
          ask1
        },
        "Invalid MEXC ticker order book"
      );

      return null;
    }

    return {
      symbol,

      timestamp:
        Number(
          row.timestamp ??
          Date.now()
        ),

      lastPrice,

      volume24:
        Number(
          row.volume24 ?? 0
        ),

      amount24:
        Number(
          row.amount24 ?? 0
        ),

      riseFallRate:
        Number(
          row.riseFallRate ?? 0
        ),

      fairPrice:
        Number(
          row.fairPrice ?? 0
        ),

      indexPrice:
        Number(
          row.indexPrice ?? 0
        ),

      maxBidPrice:
        Number(
          row.maxBidPrice ?? 0
        ),

      minAskPrice:
        Number(
          row.minAskPrice ?? 0
        ),

      lower24Price:
        Number(
          row.lower24Price ?? 0
        ),

      high24Price:
        Number(
          row.high24Price ?? 0
        ),

      bid1,
      ask1
    };
  }

  private tickerFromPushTicker(
    data: JsonRecord
  ): MexcTicker | null {
    const symbol =
      String(data.symbol ?? "");

    if (!symbol) {
      return null;
    }

    const lastPrice =
      Number(data.lastPrice ?? 0);

    const bid1 =
      Number(data.bid1 ?? 0);

    const ask1 =
      Number(data.ask1 ?? 0);

    if (
      !Number.isFinite(lastPrice) ||
      lastPrice <= 0
    ) {
      logger.warn(
        {
          symbol,
          lastPrice,
          rawLastPrice:
            data.lastPrice
        },
        "Invalid MEXC push ticker last price"
      );

      return null;
    }

    if (
      !Number.isFinite(bid1) ||
      bid1 <= 0 ||
      !Number.isFinite(ask1) ||
      ask1 <= 0 ||
      ask1 < bid1
    ) {
      logger.warn(
        {
          symbol,
          lastPrice,
          rawBid1:
            data.bid1,
          rawAsk1:
            data.ask1,
          bid1,
          ask1
        },
        "Invalid MEXC push ticker order book"
      );

      return null;
    }

    return {
      symbol,

      timestamp:
        Number(
          data.timestamp ??
          Date.now()
        ),

      lastPrice,

      volume24:
        Number(
          data.volume24 ?? 0
        ),

      amount24:
        Number(
          data.amount24 ?? 0
        ),

      riseFallRate:
        Number(
          data.riseFallRate ?? 0
        ),

      fairPrice:
        Number(
          data.fairPrice ?? 0
        ),

      indexPrice:
        Number(
          data.indexPrice ?? 0
        ),

      maxBidPrice:
        Number(
          data.maxBidPrice ?? 0
        ),

      minAskPrice:
        Number(
          data.minAskPrice ?? 0
        ),

      lower24Price:
        Number(
          data.lower24Price ?? 0
        ),

      high24Price:
        Number(
          data.high24Price ?? 0
        ),

      bid1,
      ask1
    };
  }
}
