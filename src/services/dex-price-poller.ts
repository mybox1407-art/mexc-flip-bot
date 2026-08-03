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

      for (const mapping of mappings) {
        try {
          if (!mapping.chainId || !mapping.pairAddress) {
            continue;
          }

          const pair = await this.dexClient.getPairByChainAndAddress(
            mapping.chainId,
            mapping.pairAddress
          );

          if (!pair) {
            continue;
          }

          await this.onPrice(mapping.mexcSymbol, pair);
        } catch (error) {
          logger.warn(
            {
              mexcSymbol: mapping.mexcSymbol,
              chainId: mapping.chainId,
              pairAddress: mapping.pairAddress,
              err: error
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
