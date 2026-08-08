import { mkdir } from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import { logger } from "./logger.js";

import { CsvWriter } from "./services/csv-writer.js";
import { DexMapper } from "./services/dex-mapper.js";
import { ContractWatcher } from "./services/contract-watcher.js";
import { DexPricePoller } from "./services/dex-price-poller.js";
import { SpreadEngine } from "./services/spread-engine.js";
import { PaperExecutionService } from "./services/paper-execution.js";
import { TelegramNotifier } from "./services/telegram-notifier.js";

import { MexcFuturesRestClient } from "./mexc/futures-rest.js";
import { MexcFuturesWsClient } from "./mexc/futures-ws.js";
import { DexScreenerClient } from "./mexc/dexscreener.js";

import type {
  CsvRow,
  MexcContract,
  MexcTicker
} from "./types.js";

function normalizeSymbol(
  value: string
): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-/\s]/g, "");
}

function shouldSkipDexLookup(
  symbol: string
): boolean {
  const upper =
    symbol.toUpperCase();

  const base =
    upper.split("_")[0] ??
    upper;

  if (
    upper.includes("_USD1")
  ) {
    return true;
  }

  if (
    base.includes("STOCK")
  ) {
    return true;
  }

  if (
    /(NAS100|SPX|DJI|NVIDIA|TESLA|APPLE|MSFT|SBUX|ARM|HD|COPPER)/.test(
      base
    )
  ) {
    return true;
  }

  return false;
}

function getContractMultiplier(
  symbol: string
): number {
  const base =
    String(symbol)
      .toUpperCase()
      .split("_")[0] ?? "";

  if (
    base.startsWith("1000000")
  ) {
    return 1_000_000;
  }

  if (
    base.startsWith("10000")
  ) {
    return 10_000;
  }

  if (
    base.startsWith("1000")
  ) {
    return 1_000;
  }

  return 1;
}

async function bootstrap(): Promise<void> {
  await mkdir(
    config.dataDir,
    {
      recursive: true
    }
  );

  const contractsWriter =
    new CsvWriter(
      path.join(
        config.dataDir,
        "new-contracts.csv"
      )
    );

  const dexPricesWriter =
    new CsvWriter(
      path.join(
        config.dataDir,
        "dex-prices.csv"
      )
    );

  const spreadSignalsWriter =
    new CsvWriter(
      path.join(
        config.dataDir,
        "spread-signals.csv"
      )
    );

  const paperTradeColumns = [
    "event",
    "id",
    "symbol",
    "direction",
    "status",
    "openedAt",
    "closedAt",
    "entryPrice",
    "exitPrice",
    "entryRef",
    "entryMexcBid",
    "entryMexcAsk",
    "entryMexcBookSpreadPct",
    "exitRef",
    "exitMexcBid",
    "exitMexcAsk",
    "exitMexcBookSpreadPct",
    "qtyUsd",
    "qtyToken",
    "depositAtEntry",
    "allocationPct",
    "depositAfterClose",
    "dexAnchorAtEntry",
    "dexAnchorAtExit",
    "dexSnapshotAtEntry",
    "dexSnapshotAtExit",
    "entrySpreadPct",
    "exitSpreadPct",
    "grossPnlPct",
    "netPnlPct",
    "grossPnlUsd",
    "netPnlUsd",
    "holdMs",
    "openReason",
    "closeReason"
  ] as const;

  const paperTradesWriter =
    new CsvWriter(
      path.join(
        config.dataDir,
        "paper-trades.csv"
      ),
      paperTradeColumns
    );

  const dealsWriter =
    new CsvWriter(
      path.join(
        config.dataDir,
        "deals.csv"
      )
    );

  const depthWriter =
    new CsvWriter(
      path.join(
        config.dataDir,
        "depth.csv"
      )
    );

  const mexcRestClient =
    new MexcFuturesRestClient();

  const dexScreenerClient =
    new DexScreenerClient();

  const dexMapper =
    new DexMapper();

  const spreadEngine =
    new SpreadEngine(
      dexMapper
    );

  const paperExecution =
    new PaperExecutionService();

  const telegramNotifier =
    new TelegramNotifier(
      config.telegramBotToken,
      config.telegramChatId
    );

  let mexcWsClient:
    MexcFuturesWsClient | null =
    null;

  await dexMapper.load();

  await telegramNotifier.sendStartup();

  logger.info(
    {
      initialDepositUsd: 100,
      maxOpenTrades: 3,
      tradeAllocationPct: 0.3,

      currentDepositUsd:
        paperExecution.getDepositUsd(),

      openTrades:
        paperExecution.getOpenTradesCount(),

      minSpreadPct:
        config.minSpreadPct,

      minNetEdgePct:
        config.minNetEdgePct,

      roundTripCostPct:
        config.roundTripCostPct,

      maxPriceDeviationPct:
        config.maxPriceDeviationPct,

      minDexBuysSellsM5:
        config.minDexBuysSellsM5,

      dexMinLiquidityUsd:
        config.dexMinLiquidityUsd,

      dexMinVolumeM5Usd:
        config.dexMinVolumeM5Usd,

      minMexcTurnover24h:
        config.minMexcTurnover24h,

      paperExitSpreadPct:
        config.paperExitSpreadPct,

      paperStopLossPct:
        config.paperStopLossPct,

      paperMaxHoldMs:
        config.paperMaxHoldMs,

      paperMaxAnchorMoveAgainstPct:
        config.paperMaxAnchorMoveAgainstPct,

      dexPreferredChains:
        config.dexPreferredChains,

      dexPollMs:
        config.dexPollMs,

      telegramEnabled:
        telegramNotifier.enabled,

      activeMappings:
        dexMapper.getActive().length
    },
    "Starting MEXC flip bot"
  );

  const handleNewContract = async (
    contract: MexcContract
  ): Promise<void> => {
    await contractsWriter.appendRow({
      detectedAt:
        new Date().toISOString(),

      contractId:
        contract.contractId,

      symbol:
        contract.symbol,

      displayName:
        contract.displayName ?? "",

      baseCoin:
        contract.baseCoin ?? "",

      quoteCoin:
        contract.quoteCoin ?? "",

      settleCoin:
        contract.settleCoin ?? "",

      maxLeverage:
        contract.maxLeverage ?? "",

      contractSize:
        contract.contractSize ?? ""
    });

    const existing =
      dexMapper.get(
        contract.symbol
      );

    if (
      existing &&
      existing.status === "active"
    ) {
      return;
    }

    if (
      shouldSkipDexLookup(
        contract.symbol
      )
    ) {
      logger.info(
        {
          contractId:
            contract.contractId,

          symbol:
            contract.symbol,

          displayName:
            contract.displayName,

          baseCoin:
            contract.baseCoin
        },
        "Skipping DEX lookup for unsupported synthetic contract"
      );

      return;
    }

    if (
      existing &&
      existing.status === "not_found"
    ) {
      return;
    }

    const searchQuery =
      contract.baseCoin?.trim() ||
      contract.symbol
        .split("_")[0] ||
      contract.symbol;

    const pair =
      await dexScreenerClient
        .findBestPairAcrossChains(
          searchQuery
        );

    if (!pair) {
      logger.debug(
        {
          contractId:
            contract.contractId,

          symbol:
            contract.symbol,

          searchQuery
        },
        "DEX pair not found"
      );

      return;
    }

    const contractMultiplier =
      getContractMultiplier(
        contract.symbol
      );

    const normalizedDexKey =
      normalizeSymbol(
        `${pair.baseSymbol}_${pair.quoteSymbol}`
      );

    dexMapper.upsert({
      mexcContractId:
        contract.contractId,

      mexcSymbol:
        contract.symbol,

      baseCoin:
        contract.baseCoin ?? "",

      mexcQuoteCoin:
        contract.quoteCoin ?? "",

      chainId:
        pair.chainId,

      dexId:
        pair.dexId,

      pairAddress:
        pair.pairAddress,

      baseTokenAddress:
        pair.baseTokenAddress,

      quoteTokenAddress:
        pair.quoteTokenAddress,

      quoteSymbol:
        pair.quoteSymbol,

      contractSize:
        contract.contractSize,

      contractMultiplier,

      liquidityUsd:
        pair.liquidityUsd,

      volumeM5:
        pair.volumeM5,

      priceUsd:
        pair.priceUsd,

      pairCreatedAt:
        pair.pairCreatedAt,

      status:
        "active",

      updatedAt:
        new Date().toISOString(),

      normalizedDexKey
    });

    await dexMapper.save();

    if (mexcWsClient) {
      mexcWsClient.subscribeTicker(
        contract.symbol
      );
    }

    logger.info(
      {
        contractId:
          contract.contractId,

        symbol:
          contract.symbol,

        baseCoin:
          contract.baseCoin,

        quoteCoin:
          contract.quoteCoin,

        contractSize:
          contract.contractSize,

        contractMultiplier,

        chainId:
          pair.chainId,

        dexId:
          pair.dexId,

        baseTokenAddress:
          pair.baseTokenAddress,

        pairAddress:
          pair.pairAddress,

        quoteSymbol:
          pair.quoteSymbol,

        liquidityUsd:
          pair.liquidityUsd,

        volumeM5:
          pair.volumeM5,

        priceUsd:
          pair.priceUsd,

        normalizedDexKey,

        tickerSubscribed:
          Boolean(mexcWsClient)
      },
      "New DEX mapping created"
    );
  };

  const contractWatcher =
    new ContractWatcher(
      mexcRestClient,
      handleNewContract
    );

  const dexPricePoller =
    new DexPricePoller(
      dexScreenerClient,
      dexMapper,
      async (
        mexcSymbol,
        pair
      ) => {
        const updated =
          spreadEngine.updateDexPrice(
            mexcSymbol,
            pair
          );

        if (!updated) {
          logger.warn(
            {
              mexcSymbol
            },
            "DEX price update failed"
          );
        }

        await dexPricesWriter.appendRow({
          timestamp:
            new Date().toISOString(),

          mexcSymbol,

          dexPrice:
            pair.priceUsd,

          liquidityUsd:
            pair.liquidityUsd,

          volumeM5:
            pair.volumeM5,

          buysM5:
            pair.buysM5,

          sellsM5:
            pair.sellsM5,

          dexId:
            pair.dexId,

          chainId:
            pair.chainId,

          quoteSymbol:
            pair.quoteSymbol,

          pairAddress:
            pair.pairAddress
        });
      }
    );

  mexcWsClient =
    new MexcFuturesWsClient({
      onTicker: async (
        ticker: MexcTicker
      ) => {
        const mapping =
          dexMapper.get(
            ticker.symbol
          );

        if (
          !mapping ||
          mapping.status !== "active"
        ) {
          return;
        }

        let openedNow = false;

        const signal =
          spreadEngine.evaluate(
            ticker
          );

        if (signal) {
          await spreadSignalsWriter.appendRow(
            signal as unknown as CsvRow
          );

          logger.warn(
            {
              symbol:
                signal.symbol,

              direction:
                signal.direction,

              spreadPct:
                signal.spreadPct,

              netEdgePct:
                signal.netEdgePct,

              dexPrice:
                signal.dexPrice,

              mexcPrice:
                signal.mexcPrice,

              mexcBid:
                signal.mexcBid,

              mexcAsk:
                signal.mexcAsk,

              entryRef:
                signal.entryRef,

              reason:
                signal.reason,

              currentDepositUsd:
                paperExecution.getDepositUsd(),

              openTrades:
                paperExecution.getOpenTradesCount()
            },
            "DEX anchor deviation signal detected on MEXC"
          );

          const opened =
            paperExecution.onSignal(
              signal
            );

          if (
            opened &&
            opened.action === "OPEN"
          ) {
            openedNow = true;

            await paperTradesWriter.appendRow({
              event: "OPEN",

              id:
                opened.trade.id,

              symbol:
                opened.trade.symbol,

              direction:
                opened.trade.direction,

              status:
                opened.trade.status,

              openedAt:
                opened.trade.openedAt,

              entryPrice:
                opened.trade.entryPrice,

              entryRef:
                opened.trade.entryRef,

              entryMexcBid:
                opened.trade.entryMexcBid,

              entryMexcAsk:
                opened.trade.entryMexcAsk,

              entryMexcBookSpreadPct:
                opened.trade.entryMexcBookSpreadPct,

              qtyUsd:
                opened.trade.qtyUsd,

              qtyToken:
                opened.trade.qtyToken,

              depositAtEntry:
                opened.trade.depositAtEntry,

              allocationPct:
                opened.trade.allocationPct,

              dexAnchorAtEntry:
                opened.trade.dexAnchorAtEntry,

              dexSnapshotAtEntry:
                opened.trade.dexSnapshotAtEntry,

              entrySpreadPct:
                opened.trade.entrySpreadPct,

              openReason:
                opened.trade.openReason
            });

            await telegramNotifier.sendTradeOpened(
              opened.trade
            );

            logger.warn(
              {
                id:
                  opened.trade.id,

                symbol:
                  opened.trade.symbol,

                direction:
                  opened.trade.direction,

                entryPrice:
                  opened.trade.entryPrice,

                entryMexcBid:
                  opened.trade.entryMexcBid,

                entryMexcAsk:
                  opened.trade.entryMexcAsk,

                entryMexcBookSpreadPct:
                  opened.trade.entryMexcBookSpreadPct,

                qtyUsd:
                  opened.trade.qtyUsd,

                qtyToken:
                  opened.trade.qtyToken,

                depositAtEntry:
                  opened.trade.depositAtEntry,

                allocationPct:
                  opened.trade.allocationPct,

                currentDepositUsd:
                  paperExecution.getDepositUsd(),

                openTrades:
                  paperExecution.getOpenTradesCount()
              },
              "Paper trade opened"
            );
          }
        }

        if (openedNow) {
          return;
        }

        const anchorStatus =
          spreadEngine.getAnchorStatus(
            ticker
          );

        const closed =
          paperExecution.onTicker(
            ticker,
            anchorStatus
          );

        if (
          !closed ||
          closed.action !== "CLOSE"
        ) {
          return;
        }

        await paperTradesWriter.appendRow({
          event: "CLOSE",

          id:
            closed.trade.id,

          symbol:
            closed.trade.symbol,

          direction:
            closed.trade.direction,

          status:
            closed.trade.status,

          openedAt:
            closed.trade.openedAt,

          closedAt:
            closed.trade.closedAt,

          entryPrice:
            closed.trade.entryPrice,

          exitPrice:
            closed.trade.exitPrice,

          entryRef:
            closed.trade.entryRef,

          entryMexcBid:
            closed.trade.entryMexcBid,

          entryMexcAsk:
            closed.trade.entryMexcAsk,

          entryMexcBookSpreadPct:
            closed.trade.entryMexcBookSpreadPct,

          exitRef:
            closed.trade.exitRef,

          exitMexcBid:
            closed.trade.exitMexcBid,

          exitMexcAsk:
            closed.trade.exitMexcAsk,

          exitMexcBookSpreadPct:
            closed.trade.exitMexcBookSpreadPct,

          qtyUsd:
            closed.trade.qtyUsd,

          qtyToken:
            closed.trade.qtyToken,

          depositAtEntry:
            closed.trade.depositAtEntry,

          allocationPct:
            closed.trade.allocationPct,

          depositAfterClose:
            closed.trade.depositAfterClose,

          dexAnchorAtEntry:
            closed.trade.dexAnchorAtEntry,

          dexAnchorAtExit:
            closed.trade.dexAnchorAtExit,

          dexSnapshotAtEntry:
            closed.trade.dexSnapshotAtEntry,

          dexSnapshotAtExit:
            closed.trade.dexSnapshotAtExit,

          entrySpreadPct:
            closed.trade.entrySpreadPct,

          exitSpreadPct:
            closed.trade.exitSpreadPct,

          grossPnlPct:
            closed.trade.grossPnlPct,

          netPnlPct:
            closed.trade.netPnlPct,

          grossPnlUsd:
            closed.trade.grossPnlUsd,

          netPnlUsd:
            closed.trade.netPnlUsd,

          holdMs:
            closed.trade.holdMs,

          openReason:
            closed.trade.openReason,

          closeReason:
            closed.trade.closeReason
        });

        await telegramNotifier.sendTradeClosed(
          closed.trade
        );

        logger.warn(
          {
            id:
              closed.trade.id,

            symbol:
              closed.trade.symbol,

            direction:
              closed.trade.direction,

            entryPrice:
              closed.trade.entryPrice,

            entryMexcBid:
              closed.trade.entryMexcBid,

            entryMexcAsk:
              closed.trade.entryMexcAsk,

            entryMexcBookSpreadPct:
              closed.trade.entryMexcBookSpreadPct,

            exitPrice:
              closed.trade.exitPrice,

            exitMexcBid:
              closed.trade.exitMexcBid,

            exitMexcAsk:
              closed.trade.exitMexcAsk,

            exitMexcBookSpreadPct:
              closed.trade.exitMexcBookSpreadPct,

            grossPnlPct:
              closed.trade.grossPnlPct,

            netPnlPct:
              closed.trade.netPnlPct,

            grossPnlUsd:
              closed.trade.grossPnlUsd,

            netPnlUsd:
              closed.trade.netPnlUsd,

            depositAtEntry:
              closed.trade.depositAtEntry,

            depositAfterClose:
              closed.trade.depositAfterClose,

            currentDepositUsd:
              paperExecution.getDepositUsd(),

            openTrades:
              paperExecution.getOpenTradesCount(),

            closeReason:
              closed.trade.closeReason
          },
          "Paper trade closed"
        );
      },

      onDeal: async (
        symbol,
        payload
      ) => {
        await dealsWriter.appendRow({
          timestamp:
            new Date().toISOString(),

          symbol,

          payload:
            JSON.stringify(payload)
        });
      },

      onDepth: async (
        symbol,
        payload
      ) => {
        await depthWriter.appendRow({
          timestamp:
            new Date().toISOString(),

          symbol,

          payload:
            JSON.stringify(payload)
        });
      }
    });

  if (!mexcWsClient) {
    throw new Error(
      "MEXC WebSocket client was not initialized"
    );
  }

  mexcWsClient.connect();

  await contractWatcher.start();

  const activeMappings =
    dexMapper.getActive();

  for (
    const mapping
    of activeMappings
  ) {
    mexcWsClient.subscribeTicker(
      mapping.mexcSymbol
    );
  }

  logger.info(
    {
      activeMappings:
        activeMappings.length,

      subscribedTickers:
        activeMappings.length
    },
    "Subscribed tickers for active DEX mappings"
  );

  dexPricePoller.start();

  const shutdown = async (
    signal: string
  ): Promise<void> => {
    logger.info(
      {
        signal,

        finalDepositUsd:
          paperExecution.getDepositUsd(),

        openTrades:
          paperExecution.getOpenTradesCount()
      },
      "Shutting down bot"
    );

    dexPricePoller.stop();

    mexcWsClient?.stop();

    await Promise.all([
      contractsWriter.close(),
      dexPricesWriter.close(),
      spreadSignalsWriter.close(),
      paperTradesWriter.close(),
      dealsWriter.close(),
      depthWriter.close()
    ]);

    process.exit(0);
  };

  process.on(
    "SIGINT",
    () => {
      void shutdown("SIGINT");
    }
  );

  process.on(
    "SIGTERM",
    () => {
      void shutdown("SIGTERM");
    }
  );
}

bootstrap().catch((error) => {
  logger.error(
    {
      err: error
    },
    "Bot crashed"
  );

  process.exit(1);
});
