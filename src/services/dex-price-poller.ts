import { logger } from "../logger.js";
import type { DexScreenerClient, DexPair } from "../mexc/dexscreener.js";
import type { DexMapper } from "./dex-mapper.js";
import { config } from "../config.js";

type OnPrice = (mexcSymbol: string, pair: DexPair) => void | Promise<void>;

export class DexPricePoller {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dexClient: DexScreenerClient,
    private readonly dexMapper: DexMapper,
    private readonly onPrice: OnPrice
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    logger.info("DexPricePoller started");

    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, config.dexPollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const mappings = this.dexMapper.getActive();
      
      logger.info({ count: mappings.length }, "Polling DEX prices");

      for (const mapping of mappings) {
        try {
          if (!mapping.chainId || !mapping.dexPairAddress) {
            logger.warn(
              {
                symbol: mapping.mexcSymbol,
                status: mapping.status,
                chainId: mapping.chainId,
                dexPairAddress: mapping.dexPairAddress
              },
              "Missing chainId or dexPairAddress"
            );
            continue;
          }

          const pair = await this.dexClient.getPairByChainAndAddress(
            mapping.chainId,
            mapping.dexPairAddress
          );

          if (!pair) {
            logger.warn(
              {
                symbol: mapping.mexcSymbol,
                status: mapping.status
              },
              "No pair returned from DexScreener"
            );
            continue;
          }

          logger.info(
            {
              symbol: mapping.mexcSymbol,
              price: pair.priceUsd,
              liquidity: pair.liquidityUsd
            },
            "DEX price fetched, calling onPrice"
          );

          await this.onPrice(mapping.mexcSymbol, pair);
        } catch (error) {
          logger.warn(
            {
              mexcSymbol: mapping.mexcSymbol,
              chainId: mapping.chainId,
              dexPairAddress: mapping.dexPairAddress,
              err: error,
            },
            "Failed to poll DEX price for pair"
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
