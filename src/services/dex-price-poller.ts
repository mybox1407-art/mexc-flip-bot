// src/services/dex-price-poller.ts
import { logger } from "../logger.js";

start(): void {
  if (this.timer) {
    return;
  }

  logger.info("DexPricePoller started");  // ← Добавь

  void this.poll();
  
  this.timer = setInterval(() => {
    void this.poll();
  }, config.dexPollMs);
}

private async poll(): Promise<void> {
  if (this.running) {
    return;
  }

  this.running = true;

  try {
    const mappings = this.dexMapper.getActive();
    
    logger.info({ count: mappings.length }, "Polling DEX prices");  // ← Добавь

    for (const mapping of mappings) {
      try {
        if (!mapping.chainId || !mapping.dexPairAddress) {
          continue;
        }

        const pair = await this.dexClient.getPairByChainAndAddress(
          mapping.chainId,
          mapping.dexPairAddress
        );

        if (!pair) {
          continue;
        }

        logger.debug(  // ← Добавь
          {
            symbol: mapping.mexcSymbol,
            price: pair.priceUsd,
            liquidity: pair.liquidityUsd
          },
          "DEX price updated"
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
