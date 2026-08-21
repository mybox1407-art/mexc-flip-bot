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

/**
 * Batch-опрос по сетям работает
 * всегда. Карусель включается,
 * когда уникальных DEX-пар
 * становится больше этого порога.
 */
const CAROUSEL_THRESHOLD = 100;

/**
 * Размер окна карусели —
 * сколько уникальных пар
 * опрашивается в активном окне.
 */
const CAROUSEL_WINDOW = 100;

/**
 * Длительность окна карусели:
 * 30 минут на одно окно, затем
 * переход к следующему по кругу.
 */
const CAROUSEL_WINDOW_MS =
  30 * 60 * 1000;

interface PairGroup {
  chainId: string;
  pairKey: string;
  mappings: TokenMapping[];
}

export class DexPricePoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  /**
   * Индекс активного окна
   * карусели.
   */
  private carouselWindowIndex = 0;

  /**
   * Когда активное окно
   * карусели было открыто.
   */
  private carouselWindowStartedAt =
    Date.now();

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

  /**
   * Группирует активные маппинги
   * в плоский список уникальных
   * DEX-пар. Порядок стабилен
   * между циклами: Map хранит
   * порядок вставки.
   */
  private collectPairGroups(
    mappings: TokenMapping[]
  ): PairGroup[] {
    const byChain =
      new Map<
        string,
        Map<string, TokenMapping[]>
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

      const chainId =
        mapping.chainId
          .trim()
          .toLowerCase();

      const pairKey =
        mapping.dexPairAddress
          .trim()
          .toLowerCase();

      let chainGroup =
        byChain.get(chainId);

      if (!chainGroup) {
        chainGroup = new Map();

        byChain.set(
          chainId,
          chainGroup
        );
      }

      const rows =
        chainGroup.get(pairKey) ??
        [];

      rows.push(mapping);

      chainGroup.set(
        pairKey,
        rows
      );
    }

    const groups: PairGroup[] = [];

    for (
      const [chainId, chainGroup]
      of byChain
    ) {
      for (
        const [pairKey, rows]
        of chainGroup
      ) {
        groups.push({
          chainId,
          pairKey,
          mappings: rows
        });
      }
    }

    return groups;
  }

  /**
   * Выбирает окно пар для
   * текущего цикла.
   *
   * Без карусели (пар <= 100) —
   * все пары. С каруселью —
   * активное окно на 100 пар,
   * которое сдвигается по кругу
   * каждые 30 минут.
   */
  private selectWindow(
    groups: PairGroup[],
    now: number
  ): {
    selected: PairGroup[];
    carouselActive: boolean;
    windowsTotal: number;
    windowIndex: number;
    windowRemainingMs: number;
  } {
    const totalPairs =
      groups.length;

    if (
      totalPairs <=
      CAROUSEL_THRESHOLD
    ) {
      this.carouselWindowIndex = 0;
      this.carouselWindowStartedAt =
        now;

      return {
        selected: groups,
        carouselActive: false,
        windowsTotal: 1,
        windowIndex: 0,
        windowRemainingMs: 0
      };
    }

    const windowsTotal =
      Math.ceil(
        totalPairs /
          CAROUSEL_WINDOW
      );

    /**
     * Маппинг мог сократиться —
     * клампим индекс окна.
     */
    if (
      this.carouselWindowIndex >=
      windowsTotal
    ) {
      this.carouselWindowIndex = 0;
      this.carouselWindowStartedAt =
        now;
    }

    /**
     * Ротация по elapsed-времени:
     * если поллер простаивал
     * (например, backoff после 429),
     * догоняем сразу несколько
     * окон.
     */
    const elapsedWindows =
      Math.floor(
        (now -
          this
            .carouselWindowStartedAt) /
          CAROUSEL_WINDOW_MS
      );

    if (elapsedWindows > 0) {
      this.carouselWindowIndex =
        (this.carouselWindowIndex +
          elapsedWindows) %
        windowsTotal;

      this.carouselWindowStartedAt +=
        elapsedWindows *
        CAROUSEL_WINDOW_MS;

      logger.info(
        {
          windowIndex:
            this
              .carouselWindowIndex,

          windowsTotal,

          totalPairs
        },
        "DEX carousel window rotated"
      );
    }

    const windowIndex =
      this.carouselWindowIndex;

    const start =
      windowIndex *
      CAROUSEL_WINDOW;

    const selected =
      groups.slice(
        start,
        start + CAROUSEL_WINDOW
      );

    const windowRemainingMs =
      CAROUSEL_WINDOW_MS -
      (now -
        this
          .carouselWindowStartedAt);

    return {
      selected,
      carouselActive: true,
      windowsTotal,
      windowIndex,
      windowRemainingMs
    };
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

      const allGroups =
        this.collectPairGroups(
          mappings
        );

      const {
        selected,
        carouselActive,
        windowsTotal,
        windowIndex,
        windowRemainingMs
      } =
        this.selectWindow(
          allGroups,
          startedAt
        );

      logger.debug(
        {
          activeMappings:
            mappings.length,

          uniqueDexPairs:
            allGroups.length,

          carouselActive,

          carouselWindowIndex:
            windowIndex,

          carouselWindowsTotal:
            windowsTotal,

          carouselWindowSize:
            selected.length,

          carouselWindowRemainingMs:
            windowRemainingMs,

          startedAt
        },
        "DEX poll started"
      );

      /**
       * Выбранное окно
       * перегруппировываем по сетям:
       * один batch-запрос на сеть
       * (чанки по 30 адресов внутри
       * клиента).
       */
      const selectedByChain =
        new Map<
          string,
          PairGroup[]
        >();

      for (
        const group of selected
      ) {
        const rows =
          selectedByChain.get(
            group.chainId
          ) ?? [];

        rows.push(group);

        selectedByChain.set(
          group.chainId,
          rows
        );
      }

      for (
        const [chainId, groups]
        of selectedByChain
      ) {
        if (
          this.stopped
        ) {
          break;
        }

        const requestedAddresses =
          groups
            .map(
              (group) =>
                group.mappings[0]
                  ?.dexPairAddress ??
                ""
            )
            .filter(
              (address) =>
                address.length > 0
            );

        if (
          requestedAddresses.length ===
          0
        ) {
          continue;
        }

        let pairs: Map<
          string,
          DexPair
        >;

        try {
          pairs =
            await this.dexClient
              .getPairsByChainAndAddresses(
                chainId,
                requestedAddresses
              );
        } catch (error) {
          logger.warn(
            {
              chainId,

              pairCount:
                groups.length,

              err: error
            },
            "Failed to fetch DEX pairs batch"
          );

          continue;
        }

        for (
          const group of groups
        ) {
          if (
            this.stopped
          ) {
            break;
          }

          const pair =
            pairs.get(
              group.pairKey
            );

          if (!pair) {
            logger.warn(
              {
                chainId,

                dexPairAddress:
                  group.mappings[0]
                    ?.dexPairAddress,

                symbols:
                  group.mappings.map(
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
            of group.mappings
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
