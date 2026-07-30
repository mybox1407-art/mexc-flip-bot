import { config } from "../config.js";
import { logger } from "../logger.js";
import type { DexPair, DexScreenerClient } from "../mexc/dexscreener.js";
import type { DexMapper } from "./dex-mapper.js";

type PriceCallback = (mexcSymbol: string, pair: DexPair) => void;

export class DexPricePoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: DexScreenerClient,
    private readonly mapper: DexMapper,
    private readonly onPrice: PriceCallback
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.poll();
    }, config.dexPollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const active = this.mapper.getActive();

    if (active.length === 0) {
      return;
    }

    const addressToSymbol = new Map(
      active.map((m) => [m.solanaTokenAddress, m.mexcSymbol])
    );

    try {
      const pairs = await this.client.getPairsByTokenAddresses(
        [...addressToSymbol.keys()]
      );

      for (const [address, pair] of pairs) {
        const mexcSymbol = addressToSymbol.get(address);

        if (mexcSymbol && pair.priceUsd > 0) {
          this.onPrice(mexcSymbol, pair);
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "DEX price poll failed");
    }
  }
}
