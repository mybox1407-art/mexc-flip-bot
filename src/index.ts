import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { CsvWriter } from "./services/csv-writer.js";
import { DexMapper } from "./services/dex-mapper.js";
import { MexcFuturesRestClient } from "./mexc/futures-rest.js";
import { MexcFuturesWsClient } from "./mexc/futures-ws.js";
import { DexScreenerClient } from "./mexc/dexscreener.js";
import { ContractWatcher } from "./services/contract-watcher.js";
import { DexPricePoller } from "./services/dex-price-poller.js";
import { SpreadEngine } from "./services/spread-engine.js";
import { PaperExecutionService } from "./services/paper-execution.js";
import { TelegramNotifier } from "./services/telegram-notifier.js";
import type { CsvRow, MexcContract, MexcTicker } from "./types.js";

// ========== Нормализация символов ==========

function normalizeSymbol(value: string): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-\/\s]/g, "");
}

function shouldSkipDexLookup(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  const base = upper.split("_")[0] ?? upper;
  const normalized = normalizeSymbol(base);

  if (upper.includes("_USD1")) return true;
  if (base.includes("STOCK")) return true;
  if (/(NAS100|SPX|DJI|NVIDIA|TESLA|APPLE|MSFT|SBUX|ARM|HD|COPPER)/.test(base)) return true;
  if (/^\d{3,}/.test(normalized)) return true;

  return false;
}

// ========== Bootstrap ==========

async function bootstrap(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });

  const contractsWriter = new CsvWriter(path.join(config.dataDir, "new-contracts.csv"));
  const dexPricesWriter = new CsvWriter(path.join(config.dataDir, "dex-prices.csv"));
  const spreadSignalsWriter = new CsvWriter(path.join(config.dataDir, "spread-signals.csv"));
  const paperTradesWriter = new CsvWriter(path.join(config.dataDir, "paper-trades.csv"));
  const dealsWriter = new CsvWriter(path.join(config.dataDir, "deals.csv"));
  const depthWriter = new CsvWriter(path.join(config.dataDir, "depth.csv"));

  const mexcRestClient = new MexcFuturesRestClient();
  const dexScreenerClient = new DexScreenerClient();
  const dexMapper = new DexMapper();
  const spreadEngine = new SpreadEngine(dexMapper);
  const paperExecution = new PaperExecutionService();
  const telegramNotifier = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId
  );

  await dexMapper.load();
  await telegramNotifier.sendStartup();

  logger.info(
    {
      minSpreadPct: config.minSpreadPct,
      minNetEdgePct: config.minNetEdgePct,
      dexMinLiquidityUsd: config.dexMinLiquidityUsd,
      dexMinVolumeM5Usd: config.dexMinVolumeM5Usd,
      minMexcTurnover24h: config.minMexcTurnover24h,
      paperTradeUsdSize: config.paperTradeUsdSize,
      paperExitSpreadPct: config.paperExitSpreadPct,
      paperStopSpreadPct: config.paperStopSpreadPct,
      dexPreferredChains: config.dexPreferredChains,
      dexPollMs: config.dexPollMs,
      telegramEnabled: telegramNotifier.enabled,
      activeMappings: dexMapper.getActive().length
    },
    "Starting MEXC flip bot: DEX anchor + MEXC paper execution mode"
  );

  // ========== Обработчик новых контрактов ==========

  const handleNewContract = async (contract: MexcContract): Promise<void> => {
    await contractsWriter.appendRow({
      detectedAt: new Date().toISOString(),
      symbol: contract.symbol,
      displayName: contract.displayName ?? "",
      baseCoin: contract.baseCoin ?? "",
      quoteCoin: contract.quoteCoin ?? "",
      settleCoin: contract.settleCoin ?? "",
      maxLeverage: contract.maxLeverage ?? "",
      contractSize: contract.contractSize ?? ""
    });

    const normalizedSymbol = normalizeSymbol(contract.symbol);

    const existing = dexMapper.get(contract.symbol);
    if (existing && existing.status === "active") {
      logger.debug(
        {
          symbol: contract.symbol,
          normalizedSymbol,
          chainId: existing.chainId,
          dexId: existing.dexId,
          status: existing.status
        },
        "✅ Mapping already exists, skipping DEX lookup"
      );
      return;
    }

    if (shouldSkipDexLookup(contract.symbol)) {
      logger.info(
        { symbol: contract.symbol, displayName: contract.displayName, baseCoin: contract.baseCoin },
        "⛔ Skipping DEX lookup for unsupported synthetic contract"
      );
      // Убрано: await dexMapper.markNotFound(...)
      return;
    }

    if (existing && existing.status === "not_found") {
      logger.debug(
        { symbol: contract.symbol, mappedAt: existing.mappedAt },
        "⏭️ Mapping already marked as not_found, skipping DEX lookup"
      );
      return;
    }

    const searchQuery = contract.baseCoin ?? contract.symbol.split("_")[0] ?? contract.symbol;
    logger.info(
      { symbol: contract.symbol, baseCoin: contract.baseCoin, searchQuery },
      "🔍 Searching DEX pair for new contract"
    );

    const pair = await dexScreenerClient.findBestPairAcrossChains(searchQuery);

    if (!pair) {
      logger.info(
        { symbol: contract.symbol, baseCoin: contract.baseCoin, searchQuery },
        "❌ No supported DEX pair found"
      );
      // Убрано: await dexMapper.markNotFound(...)
      return;
    }

    const normalizedDexKey = normalizeSymbol(`${pair.baseSymbol}_${pair.quoteSymbol}`);

    dexMapper.upsert({
      mexcSymbol: contract.symbol,
      chainId: pair.chainId,
      dexId: pair.dexId,
      pairAddress: pair.pairAddress,
      baseTokenAddress: pair.baseTokenAddress,
      quoteTokenAddress: pair.quoteTokenAddress,
      quoteSymbol: pair.quoteSymbol,
      liquidityUsd: pair.liquidityUsd,
      volumeM5: pair.volumeM5,
      priceUsd: pair.priceUsd,
      status: "active",
      updatedAt: new Date().toISOString(),
      normalizedDexKey
    });

    await dexMapper.save();

    logger.info(
      {
        symbol: contract.symbol,
        normalizedSymbol,
        chainId: pair.chainId,
        dexId: pair.dexId,
        quoteSymbol: pair.quoteSymbol,
        liquidityUsd: pair.liquidityUsd,
        volumeM5: pair.volumeM5,
        priceUsd: pair.priceUsd,
        normalizedDexKey
      },
      "✅ New DEX mapping created"
    );
  };

  const contractWatcher = new ContractWatcher(mexcRestClient, handleNewContract);

  // ========== DEX Price Poller ==========

  const dexPricePoller = new DexPricePoller(
    dexScreenerClient,
    dexMapper,
    async (mexcSymbol, pair) => {
      spreadEngine.updateDexPrice(mexcSymbol, pair);

      await dexPricesWriter.appendRow({
        timestamp: new Date().toISOString(),
        mexcSymbol,
        dexPrice: pair.priceUsd,
        liquidityUsd: pair.liquidityUsd,
        volumeM5: pair.volumeM5,
        buysM5: pair.buysM5,
        sellsM5: pair.sellsM5,
        dexId: pair.dexId,
        chainId: pair.chainId,
        quoteSymbol: pair.quoteSymbol,
        pairAddress: pair.pairAddress
      });
    }
  );

  // ========== MEXC WebSocket ==========

  const mexcWsClient = new MexcFuturesWsClient({
    onTicker: async (ticker: MexcTicker) => {
      const signal = spreadEngine.evaluate(ticker);

      if (signal) {
        await spreadSignalsWriter.appendRow(signal as unknown as CsvRow);

        logger.warn(
          {
            symbol: signal.symbol,
            direction: signal.direction,
            spreadPct: signal.spreadPct,
            netEdgePct: signal.netEdgePct,
            dexPrice: signal.dexPrice,
            mexcPrice: signal.mexcPrice,
            mexcBid: signal.mexcBid,
            mexcAsk: signal.mexcAsk,
            entryRef: signal.entryRef,
            reason: signal.reason
          },
          "DEX anchor deviation signal detected on MEXC"
        );

        const opened = paperExecution.onSignal(signal);

        if (opened?.action === "OPEN") {
          await paperTradesWriter.appendRow({
            event: "OPEN",
            id: opened.trade.id,
            symbol: opened.trade.symbol,
            direction: opened.trade.direction,
            openedAt: opened.trade.openedAt,
            entryPrice: opened.trade.entryPrice,
            entryRef: opened.trade.entryRef,
            qtyUsd: opened.trade.qtyUsd,
            qtyToken: opened.trade.qtyToken,
            dexAnchorAtEntry: opened.trade.dexAnchorAtEntry,
            entrySpreadPct: opened.trade.entrySpreadPct,
            openReason: opened.trade.openReason
          });

          await telegramNotifier.sendTradeOpened(opened.trade);

          logger.warn(
            {
              id: opened.trade.id,
              symbol: opened.trade.symbol,
              direction: opened.trade.direction,
              entryPrice: opened.trade.entryPrice,
              qtyUsd: opened.trade.qtyUsd,
              qtyToken: opened.trade.qtyToken
            },
            "Paper trade opened"
          );
        }
      }

      const anchorStatus = spreadEngine.getAnchorStatus(ticker);
      const closed = paperExecution.onTicker(ticker, anchorStatus);

      if (closed?.action === "CLOSE") {
        await paperTradesWriter.appendRow({
          event: "CLOSE",
          id: closed.trade.id,
          symbol: closed.trade.symbol,
          direction: closed.trade.direction,
          openedAt: closed.trade.openedAt,
          closedAt: closed.trade.closedAt,
          entryPrice: closed.trade.entryPrice,
          exitPrice: closed.trade.exitPrice,
          entryRef: closed.trade.entryRef,
          exitRef: closed.trade.exitRef,
          qtyUsd: closed.trade.qtyUsd,
          qtyToken: closed.trade.qtyToken,
          dexAnchorAtEntry: closed.trade.dexAnchorAtEntry,
          dexAnchorAtExit: closed.trade.dexAnchorAtExit,
          entrySpreadPct: closed.trade.entrySpreadPct,
          exitSpreadPct: closed.trade.exitSpreadPct,
          grossPnlPct: closed.trade.grossPnlPct,
          netPnlPct: closed.trade.netPnlPct,
          grossPnlUsd: closed.trade.grossPnlUsd,
          netPnlUsd: closed.trade.netPnlUsd,
          holdMs: closed.trade.holdMs,
          openReason: closed.trade.openReason,
          closeReason: closed.trade.closeReason
        });

        await telegramNotifier.sendTradeClosed(closed.trade);

        logger.warn(
          {
            id: closed.trade.id,
            symbol: closed.trade.symbol,
            direction: closed.trade.direction,
            entryPrice: closed.trade.entryPrice,
            exitPrice: closed.trade.exitPrice,
            netPnlPct: closed.trade.netPnlPct,
            netPnlUsd: closed.trade.netPnlUsd,
            closeReason: closed.trade.closeReason
          },
          "Paper trade closed"
        );
      }
    },
    onDeal: async (symbol, payload) => {
      await dealsWriter.appendRow({
        timestamp: new Date().toISOString(),
        symbol,
        payload: JSON.stringify(payload)
      });
    },
    onDepth: async (symbol, payload) => {
      await depthWriter.appendRow({
        timestamp: new Date().toISOString(),
        symbol,
        payload: JSON.stringify(payload)
      });
    }
  });

  mexcWsClient.connect();
  await contractWatcher.start();
  dexPricePoller.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down bot");

    dexPricePoller.stop();
    mexcWsClient.stop();

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

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Bot crashed");
  process.exit(1);
});
