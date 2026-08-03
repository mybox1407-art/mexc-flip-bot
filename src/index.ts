import { config } from "./config.js";
import { logger } from "./logger.js";
import { MexcFuturesRestClient } from "./mexc/futures-rest.js";
import { MexcFuturesWsClient } from "./mexc/futures-ws.js";
import { DexScreenerClient } from "./mexc/dexscreener.js";
import { ContractWatcher } from "./services/contract-watcher.js";
import { CsvWriter } from "./services/csv-writer.js";
import { DexMapper } from "./services/dex-mapper.js";
import { DexPricePoller } from "./services/dex-price-poller.js";
import { SpreadEngine } from "./services/spread-engine.js";
import { dateStamp, isoNow } from "./utils/time.js";
import type { MexcContract } from "./types.js";

const csv = new CsvWriter();
const restClient = new MexcFuturesRestClient();
const dexClient = new DexScreenerClient();
const dexMapper = new DexMapper();
const spreadEngine = new SpreadEngine();

const wsClient = new MexcFuturesWsClient({
  onTicker: (ticker) => {
    const signal = spreadEngine.evaluate(ticker);

    if (!signal) {
      return;
    }

    logger.info(signal, "DEX-MEXC spread signal detected");
    void csv.append(`spread-signals-${dateStamp()}.csv`, signal);
  },

  onDeal: (symbol, payload) => {
    void csv.append(`deals-${dateStamp()}.csv`, {
      timestamp: isoNow(),
      symbol,
      payload: JSON.stringify(payload)
    });
  },

  onDepth: (symbol, payload) => {
    void csv.append(`depth-${dateStamp()}.csv`, {
      timestamp: isoNow(),
      symbol,
      payload: JSON.stringify(payload)
    });
  }
});

const dexPoller = new DexPricePoller(dexClient, dexMapper, (mexcSymbol, pair) => {
  spreadEngine.updateDexPrice(mexcSymbol, pair);

  void csv.append(`dex-prices-${dateStamp()}.csv`, {
    timestamp: isoNow(),
    mexcSymbol,
    dexPrice: pair.priceUsd,
    liquidityUsd: pair.liquidityUsd,
    volumeM5: pair.volumeM5,
    dexId: pair.dexId,
    chainId: pair.chainId,
    quoteSymbol: pair.quoteSymbol
  });
});

async function handleNewContract(contract: MexcContract): Promise<void> {
  const baseCoin = String(contract.baseCoin ?? contract.symbol.split("_")[0]);

  await csv.append(`new-contracts-${dateStamp()}.csv`, {
    detectedAt: isoNow(),
    symbol: contract.symbol,
    baseCoin,
    maxLeverage: contract.maxLeverage
  });

  wsClient.subscribeDeals(contract.symbol);
  wsClient.subscribeDepth(contract.symbol);

  if (dexMapper.get(contract.symbol)) {
    return;
  }

  const pair = await dexClient.findBestPairAcrossChains(baseCoin);

  if (!pair) {
    logger.warn(
      { symbol: contract.symbol, baseCoin, chains: config.dexPreferredChains },
      "No supported DEX pair found for new contract"
    );
    await dexMapper.markNotFound(contract.symbol, baseCoin);
    return;
  }

  const mapping = await dexMapper.addFromPair(contract.symbol, baseCoin, pair);

  logger.info(
    {
      symbol: contract.symbol,
      chainId: mapping.chainId,
      dexPair: mapping.dexPairAddress,
      liquidity: mapping.liquidityUsd,
      dexId: mapping.dexId,
      quoteSymbol: mapping.quoteSymbol
    },
    "Mapped MEXC contract to multi-chain DEX pair"
  );
}

const contractWatcher = new ContractWatcher(restClient, handleNewContract);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown started");
  wsClient.stop();
  dexPoller.stop();
  process.exit(0);
}

async function bootstrap(): Promise<void> {
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

  await dexMapper.load();
  wsClient.connect();
  dexPoller.start();
  await contractWatcher.start();
}

void bootstrap();
