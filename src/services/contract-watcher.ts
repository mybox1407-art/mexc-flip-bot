import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ContractWatchState, MexcContract } from "../types.js";
import { MexcFuturesRestClient } from "../mexc/futures-rest.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ContractWatcher {
  private readonly knownSymbols = new Set<string>();
  private readonly states = new Map<string, ContractWatchState>();
  private initialized = false;
  private refreshInProgress = false;

  constructor(
    private readonly client: MexcFuturesRestClient,
    private readonly onNewContract: (contract: MexcContract) => Promise<void>
  ) {}

  async start(): Promise<void> {
    await this.refresh();

    setInterval(() => {
      void this.refresh();
    }, config.contractRefreshMs);
  }

  // ✅ FIX #8: Добавлен retry с backoff
  private async refresh(): Promise<void> {
    if (this.refreshInProgress) {
      return;
    }

    this.refreshInProgress = true;

    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const contracts = await this.client.getContracts();
        const now = Date.now();

        for (const contract of contracts) {
          this.knownSymbols.add(contract.symbol);

          if (!this.states.has(contract.symbol)) {
            this.states.set(contract.symbol, {
              symbol: contract.symbol,
              firstSeenAt: now,
              lastCheckedAt: null,
              lastMappedAt: null,
              checksCount: 0
            });
          }
        }

        if (!this.initialized) {
          this.initialized = true;

          //logger.info(
          //  { contracts: this.knownSymbols.size },
          //  "Initial MEXC contracts snapshot loaded"
          //);

          const startupCandidates = contracts
            .slice(-config.startupBackfillLimit)
            .reverse();

          //logger.info(
          //  {
          //    count: startupCandidates.length,
          //    lookbackHours: config.contractLookbackHours
          //  },
          //  "Running startup rolling-window backfill"
          //);

          for (const contract of startupCandidates) {
            await this.processContractIfDue(contract, true);
          }

          //logger.info(
          //  { processed: startupCandidates.length },
          //  "Startup rolling-window backfill completed"
          //);

          break;
        }

        for (const contract of contracts) {
          const state = this.states.get(contract.symbol);

          if (!state) {
            continue;
          }

          const ageHours = (now - state.firstSeenAt) / 3_600_000;

          if (ageHours > config.contractLookbackHours) {
            continue;
          }

          await this.processContractIfDue(contract, false);
        }

        this.pruneOldStates(now);
        break;
      } catch (error) {
        if (attempt === maxRetries) {
          logger.error(
            { err: error, attempt },
            "Could not refresh MEXC contracts after retries"
          );
        } else {
          logger.warn(
            { err: error, attempt },
            "Refresh failed, retrying"
          );
          await sleep(attempt * 2000);
        }
      }
    }

    this.refreshInProgress = false;
  }

  private async processContractIfDue(
    contract: MexcContract,
    forceInitialScan: boolean
  ): Promise<void> {
    const state = this.states.get(contract.symbol);

    if (!state) {
      return;
    }

    const now = Date.now();
    const ageHours = (now - state.firstSeenAt) / 3_600_000;
    const isNewlySeen = state.checksCount === 0;

    const recheckMs =
      ageHours <= config.contractHotHours
        ? config.contractHotRecheckMs
        : config.contractWarmRecheckMs;

    const due =
      forceInitialScan ||
      state.lastCheckedAt === null ||
      now - state.lastCheckedAt >= recheckMs;

    if (!due) {
      return;
    }

    state.lastCheckedAt = now;
    state.checksCount += 1;

    if (isNewlySeen && !forceInitialScan) {
      logger.warn(
        {
          symbol: contract.symbol,
          displayName: contract.displayName,
          baseCoin: contract.baseCoin
        },
        "New MEXC futures contract detected"
      );
    } else {
      //logger.info(
      //  {
      //    symbol: contract.symbol,
      //    ageHours: Number(ageHours.toFixed(2)),
      //    checksCount: state.checksCount,
      //    recheckMs
      //  },
      //  "Rechecking MEXC contract inside rolling window"
      //);
    }

    try {
      await this.onNewContract(contract);
      state.lastMappedAt = Date.now();
    } catch (error) {
      logger.error(
        {
          err: error,
          symbol: contract.symbol,
          ageHours: Number(ageHours.toFixed(2))
        },
        "Contract processing failed"
      );
    }
  }

  private pruneOldStates(now: number): void {
    const maxAgeMs = Math.max(config.contractLookbackHours, 24 * 7) * 3_600_000;
    let pruned = 0;

    for (const [symbol, state] of this.states.entries()) {
      if (now - state.firstSeenAt <= maxAgeMs) {
        continue;
      }

      this.states.delete(symbol);
      pruned += 1;
    }

    if (pruned > 0) {
      logger.info({ pruned }, "Pruned old contract watch states");
    }
  }
}
