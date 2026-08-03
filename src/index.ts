import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { CsvWriter } from "./storage/csv-writer.js";
import { DexMappingStore } from "./storage/dex-mapping-store.js";
import { MexcFuturesRestClient } from "./mexc/futures-rest.js";
import { MexcFuturesWsClient } from "./mexc/futures-ws.js";
import { DexScreenerClient } from "./mexc/dexscreener.js";
import { ContractWatcher } from "./services/contract-watcher.js";
import { DexPricePoller } from "./services/dex-price-poller.js";
import { SpreadEngine } from "./services/spread-engine.js";
import type { MexcContract, MexcTicker } from "./types.js";

function shouldSkipDexLookup(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  const base = upper.split("_")[0] ?? upper;

  if (upper.includes("_USD1")) {
    return true;
  }

  if (base.includes("STOCK")) {
    return true;
  }

  if (/(NAS100|SPX|DJI|NVIDIA|TESLA|APPLE|MSFT|SBUX|ARM|HD)/.test(base)) {
    return true;
  }

  if (/^\d{3,}/.test(base)) {
    return true;
  }

  return false;
}

async function bootstrap(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });

  const contractsWriter = new CsvWriter(path.join(config.dataDir, "new-contracts.csv"));
  const dexPricesWriter = new CsvWriter(path.join(config.dataDir, "dex-prices.csv"));
  const spreadSignalsWriter = new CsvWriter(path.join(config.dataDir, "spread-signals.csv"));
  const dealsWriter = new CsvWriter(path.join(config.dataDir, "deals.csv"));
  const depthWriter = new CsvWriter(path.join(config.dataDir, "depth.csv"));

  const mexcRestClient = new MexcFuturesRestClient(config.mexcRestUrl);
  const mexcWsClient = new MexcFuturesWsClient(config.mexcWsUrl);
  const dexScreenerClient = new DexScreenerClient();
  const dexMappingStore = new DexMappingStore(path.join(config.dataDir, "dex-mapping.json"));
  const spreadEngine = new SpreadEngine();

  await dexMappingStore.load();

  logger.info(
    {
      minSpreadPct: config.minSpreadPct,
      dexMinLiquidityUsd: config.dexMinLiquidityUsd,
      dexMinVolumeM5Usd: config.dexMinVolumeM5Usd,
      dexPreferredChains: config.dexPreferredChains,
      dexPollMs: config.dexPollMs
    },
    "Starting MEXC flip bot: multi-chain DEX-MEXC spread mode"
  );

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

    if (shouldSkipDexLookup(contract.symbol)) {
      logger.info(
        {
          symbol: contract.symbol,
          displayName: contract.displayName,
          baseCoin: contract.baseCoin
        },
        "Skipping DEX lookup for unsupported synthetic contract"
      );
      return;
    }

    const pair = await dexScreenerClient.findBestPairAcrossChains(
      contract.baseCoin ?? contract.symbol.split("_")[0] ?? contract.symbol
    );

    if (!pair) {
      logger.info(
        {
          symbol: contract.symbol,
          baseCoin: contract.baseCoin
        },
        "No supported DEX pair found for new contract"
      );
      return;
    }

    await dexMappingStore.upsert({
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
      updatedAt: new Date().toISOString()
    });

    logger.info(
      {
        symbol: contract.symbol,
        chainId: pair.chainId,
        dexId: pair.dexId,
        quoteSymbol: pair.quoteSymbol,
        liquidityUsd: pair.liquidityUsd,
        volumeM5: pair.volumeM5,
        priceUsd: pair.priceUsd
      },
      "Mapped MEXC contract to multi-chain DEX pair"
    );
  };

  const contractWatcher = new ContractWatcher(mexcRestClient, handleNewContract);

  const dexPricePoller = new DexPricePoller(
    dexScreenerClient,
    dexMappingStore,
    async (mapping, pair) => {
      spreadEngine.updateDexPrice(mapping.mexcSymbol, pair);

      await dexPricesWriter.appendRow({
        timestamp: new Date().toISOString(),
        mexcSymbol: mapping.mexcSymbol,
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

  mexcWsClient.onTicker(async (ticker: MexcTicker) => {
    const signal = spreadEngine.evaluate(ticker);

    if (signal) {
      await spreadSignalsWriter.appendRow(signal);

      logger.warn(
        {
          symbol: signal.symbol,
          direction: signal.direction,
          spreadPct: signal.spreadPct,
          netEdgePct: signal.netEdgePct,
          priceDeviationPct: signal.priceDeviationPct,
          dexPrice: signal.dexPrice,
          mexcPrice: signal.mexcPrice,
          dexLiquidityUsd: signal.dexLiquidityUsd,
          dexVolumeM5: signal.dexVolumeM5
        },
        "DEX-MEXC spread signal detected"
      );
    }
  });

  mexcWsClient.onDeal(async (deal) => {
    await dealsWriter.appendRow(deal);
  });

  mexcWsClient.onDepth(async (depth) => {
    await depthWriter.appendRow(depth);
  });

  await mexcWsClient.connect();
  await contractWatcher.start();
  dexPricePoller.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down bot");

    dexPricePoller.stop();
    mexcWsClient.close();

    await Promise.all([
      contractsWriter.close(),
      dexPricesWriter.close(),
      spreadSignalsWriter.close(),
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
