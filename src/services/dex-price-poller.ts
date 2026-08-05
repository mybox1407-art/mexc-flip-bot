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
            { symbol: mapping.mexcSymbol },
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
            { symbol: mapping.mexcSymbol },
            "No pair returned from DexScreener"
          );
          continue;
        }

        logger.debug(
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
