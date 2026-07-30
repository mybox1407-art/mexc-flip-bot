import { config } from "../config.js";
import { logger } from "../logger.js";
import type { MexcContract } from "../types.js";
import { MexcFuturesRestClient } from "../mexc/futures-rest.js";

export class ContractWatcher {
  private readonly knownSymbols = new Set<string>();
  private initialized = false;

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

  private async refresh(): Promise<void> {
    try {
      const contracts = await this.client.getContracts();

      if (!this.initialized) {
        for (const contract of contracts) {
          this.knownSymbols.add(contract.symbol);
        }

        this.initialized = true;

        logger.info(
          { contracts: this.knownSymbols.size },
          "Initial MEXC contracts snapshot loaded"
        );

        return;
      }

      for (const contract of contracts) {
        if (this.knownSymbols.has(contract.symbol)) {
          continue;
        }

        this.knownSymbols.add(contract.symbol);

        logger.warn(
          {
            symbol: contract.symbol,
            displayName: contract.displayName,
            baseCoin: contract.baseCoin
          },
          "New MEXC futures contract detected"
        );

        await this.onNewContract(contract);
      }
    } catch (error) {
      logger.error({ err: error }, "Could not refresh MEXC contracts");
    }
  }
}
