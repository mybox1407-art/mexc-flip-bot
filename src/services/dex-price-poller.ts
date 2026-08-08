import { logger } from "../logger.js";
import type {
  DexScreenerClient,
  DexPair
} from "../mexc/dexscreener.js";

import type {
  DexMapper,
  TokenMapping
} from "./dex-mapper.js";

import { config } from "../config.js";

type OnPrice = (
  mexcSymbol: string,
  pair: DexPair
) => void | Promise<void>;

function getDexPairKey(
  mapping: TokenMapping
): string {
  return [
    mapping.chainId
      .trim()
      .toLowerCase(),

    mapping.dexPairAddress
      .trim()
      .toLowerCase()
  ].join(":");
}

export class DexPricePoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly dexClient: DexScreenerClient,
    private readonly dexMapper: DexMapper,
    private readonly onPrice: OnPrice
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.stopped = false;

    logger.info(
      "DexPricePoller started"
    );

    void this.poll();

    this.timer =
      setInterval(
        () => {
          void this.poll();
        },
        config.dexPollMs
      );
  }

  stop(): void {
    this.stopped = true;

    if (this.timer) {
      clearInterval(
        this.timer
      );

      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (
      this.running ||
      this.stopped
    ) {
      return;
    }

    this.running = true;

    const startedAt =
      Date.now();

    try {
      const mappings =
        this.dexMapper.getActive();

      /**
       * Группируем MEXC mappings
       * по одному DEX pool:
       *
       * chainId + dexPairAddress
       */
      const grouped =
        new Map<
          string,
          TokenMapping[]
        >();

      for (
        const mapping of mappings
      ) {
        if (
          !mapping.chainId ||
          !mapping.dexPairAddress
        ) {
          logger.warn(
            {
              symbol:
                mapping.mexcSymbol,

              status:
                mapping.status,

              chainId:
                mapping.chainId,

              dexPairAddress:
                mapping.dexPairAddress
            },
            "Missing chainId or dexPairAddress"
          );

          continue;
        }

        const key =
          getDexPairKey(
            mapping
          );

        const rows =
          grouped.get(key) ?? [];

        rows.push(mapping);

        grouped.set(
          key,
          rows
        );
      }

      logger.debug(
        {
          activeMappings:
            mappings.length,

          uniqueDexPairs:
            grouped.size,

          startedAt
        },
        "DEX poll started"
      );

      /**
       * Один запрос на один
       * уникальный DEX pair.
       */
      for (
        const pairMappings
        of grouped.values()
      ) {
        if (
          this.stopped
        ) {
          break;
        }

        const first =
          pairMappings[0];

        if (!first) {
          continue;
        }

        let pair: DexPair | null =
          null;

        try {
          pair =
            await this.dexClient
              .getPairByChainAndAddress(
                first.chainId,
                first.dexPairAddress
              );
        } catch (error) {
          logger.warn(
            {
              chainId:
                first.chainId,

              dexPairAddress:
                first.dexPairAddress,

              symbols:
                pairMappings.map(
                  (mapping) =>
                    mapping.mexcSymbol
                ),

              err: error
            },
            "Failed to fetch shared DEX pair"
          );

          continue;
        }

        if (!pair) {
          logger.warn(
            {
              chainId:
                first.chainId,

              dexPairAddress:
                first.dexPairAddress,

              symbols:
                pairMappings.map(
                  (mapping) =>
                    mapping.mexcSymbol
                )
            },
            "No shared pair returned from DexScreener"
          );

          continue;
        }

        /**
         * Один pair отправляем всем
         * MEXC symbols, которые
         * используют этот pool.
         *
         * SpreadEngine сам создаёт
         * отдельное состояние
         * для каждого mexcSymbol.
         */
        for (
          const mapping
          of pairMappings
        ) {
          if (
            this.stopped
          ) {
            break;
          }

          try {
            await this.onPrice(
              mapping.mexcSymbol,
              pair
            );
          } catch (error) {
            logger.warn(
              {
                mexcSymbol:
                  mapping.mexcSymbol,

                chainId:
                  mapping.chainId,

                dexPairAddress:
                  mapping.dexPairAddress,

                err: error
              },
              "Failed to process DEX price"
            );
          }
        }
      }
    } finally {
      this.running = false;

      logger.debug(
        {
          durationMs:
            Date.now() - startedAt
        },
        "DEX poll completed"
      );
    }
  }
}
