import { config } from "./config.js";
import { logger } from "./logger.js";
import { MexcFuturesRestClient } from "./mexc/futures-rest.js";
import { MexcFuturesWsClient } from "./mexc/futures-ws.js";
import { ContractWatcher } from "./services/contract-watcher.js";
import { CsvWriter } from "./services/csv-writer.js";
import { MarketCache } from "./services/market-cache.js";
import { SignalEngine } from "./services/signal-engine.js";
import { dateStamp, isoNow } from "./utils/time.js";

const csv = new CsvWriter();
const marketCache = new MarketCache();
const signalEngine = new SignalEngine(marketCache);
const restClient = new MexcFuturesRestClient();

const trackedSymbols = new Set<string>();

const wsClient = new MexcFuturesWsClient({
  onTicker: (ticker) => {
    marketCache.updateTicker(ticker);

    const signal = signalEngine.evaluate(ticker);

    if (!signal) {
      return;
    }

    logger.info(signal, "Paper signal detected");

    void csv.append(`signals-${dateStamp()}.csv`, signal);
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
  },

  onConnected: () => {
    logger.info("MEXC WS subscriptions restored");
  }
});

async function handleNewContract(contract: {
  symbol: string;
  displayName?: string;
  baseCoin?: string;
  quoteCoin?: string;
  settleCoin?: string;
  maxLeverage?: number;
}): Promise<void> {
  await csv.append(`new-contracts-${dateStamp()}.csv`, {
    detectedAt: isoNow(),
    symbol: contract.symbol,
    displayName: contract.displayName,
    baseCoin: contract.baseCoin,
    quoteCoin: contract.quoteCoin,
    settleCoin: contract.settleCoin,
    maxLeverage: contract.maxLeverage
  });

  if (trackedSymbols.size >= config.maxTrackedNewContracts) {
    logger.warn(
      { symbol: contract.symbol },
      "New contract logged but not subscribed: tracked contracts limit reached"
    );

    return;
  }

  trackedSymbols.add(contract.symbol);

  wsClient.subscribeDeals(contract.symbol);
  wsClient.subscribeDepth(contract.symbol);

  logger.info(
    { symbol: contract.symbol },
    "Subscribed to deal and depth streams for new contract"
  );
}

const contractWatcher = new ContractWatcher(restClient, handleNewContract);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown started");
  wsClient.stop();
  process.exit(0);
}

async function bootstrap(): Promise<void> {
  logger.info(
    {
      signalWindowMs: config.signalWindowMs,
      minMovePct: config.signalMinMovePct,
      minTurnoverUsdt: config.signalMinTurnoverUsdt
    },
    "Starting MEXC flip bot in paper-signal mode"
  );

  wsClient.connect();
  await contractWatcher.start();
}

void bootstrap();
