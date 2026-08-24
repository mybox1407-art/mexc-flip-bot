import { config } from "../config.js";
import { logger } from "../logger.js";

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  baseSymbol: string;
  quoteSymbol: string;
  liquidityUsd: number;
  volumeM5: number;
  buysM5: number;
  sellsM5: number;
  priceUsd: number;
  pairCreatedAt?: number;
}

interface DexSearchResponse {
  pairs?: Array<{
    chainId?: string;
    dexId?: string;
    pairAddress?: string;
    priceUsd?: string;
    pairCreatedAt?: number;

    liquidity?: {
      usd?: number;
    };

    volume?: {
      m5?: number;
    };

    txns?: {
      m5?: {
        buys?: number;
        sells?: number;
      };
    };

    baseToken?: {
      address?: string;
      symbol?: string;
      name?: string;
    };

    quoteToken?: {
      address?: string;
      symbol?: string;
      name?: string;
    };
  }>;
}

/**
 * DexScreener принимает до 30
 * адресов пар в одном запросе:
 * /pairs/{chainId}/{addr1,...,addr30}
 */
const MAX_PAIRS_PER_BATCH_REQUEST = 30;

/**
 * TTL кэша для search-запросов.
 */
const SEARCH_CACHE_TTL_MS = 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeSymbol(value: string): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-/\s]/g, "");
}

function isBlockedBaseSymbol(
  symbol: string
): boolean {
  const upper = symbol.toUpperCase();

  const blockedExact = [
    "USD1",
    "STOCK",
    "NASDAQ",
    "NAS100",
    "SPX",
    "DJI",
    "TESLA",
    "NVIDIA",
    "APPLE",
    "MSFT",
    "SBUX",
    "ARM",
    "HD",
    "COPPER"
  ];

  return blockedExact.includes(upper);
}

interface CachedSearchResult {
  pair: DexPair | null;
  expiresAt: number;
}

export class DexScreenerClient {
  private readonly baseUrl =
    "https://api.dexscreener.com/latest/dex";

  private requestCounter = 0;

  /**
   * Кэш для search-запросов.
   * Ключ: normalized query.
   */
  private readonly searchCache =
    new Map<string, CachedSearchResult>();

  private async fetchJsonWithRetry(
    url: string,
    query?: string
  ): Promise<DexSearchResponse | null> {
    const requestId =
      ++this.requestCounter;

    for (
      let attempt = 1;
      attempt <= 4;
      attempt += 1
    ) {
      const startedAt = Date.now();

      try {
        const response =
          await fetch(url);

        const durationMs =
          Date.now() - startedAt;

        const retryAfter =
          response.headers.get(
            "retry-after"
          );

        if (response.status === 429) {
          const retryAfterSeconds =
            Number(retryAfter);

          const retryAfterMs =
            Number.isFinite(
              retryAfterSeconds
            ) &&
            retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : 0;

          const backoffMs =
            retryAfterMs > 0
              ? retryAfterMs
              : attempt * 2500;

          logger.warn(
            {
              requestId,
              attempt,
              backoffMs,
              retryAfter,
              url,
              query
            },
            "DexScreener rate limited, backing off"
          );

          await sleep(backoffMs);
          continue;
        }

        if (response.status === 400) {
          logger.warn(
            {
              requestId,
              attempt,
              url,
              query,
              durationMs
            },
            "DexScreener returned 400"
          );

          return null;
        }

        if (!response.ok) {
          logger.warn(
            {
              requestId,
              attempt,
              status: response.status,
              statusText: response.statusText,
              url,
              query,
              durationMs
            },
            "DexScreener returned HTTP error"
          );

          if (attempt < 4) {
            await sleep(attempt * 1500);
            continue;
          }

          return null;
        }

        const payload =
          (await response.json()) as DexSearchResponse;

        return payload;
      } catch (error) {
        const durationMs =
          Date.now() - startedAt;

        logger.warn(
          {
            requestId,
            attempt,
            url,
            query,
            durationMs,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          },
          "DexScreener request failed"
        );

        if (attempt < 4) {
          await sleep(attempt * 1500);
          continue;
        }

        logger.error(
          {
            requestId,
            url,
            query
          },
          "DexScreener request retries exhausted"
        );

        return null;
      }
    }

    return null;
  }

  private async findPairByQuery(
    query: string
  ): Promise<DexPair | null> {
    const normalizedQuery =
      normalizeSymbol(query);

    // Фильтр: длина < 2
    if (
      !normalizedQuery ||
      normalizedQuery.length < 2 ||
      isBlockedBaseSymbol(normalizedQuery)
    ) {
      logger.debug(
        {
          query,
          normalizedQuery
        },
        "DexScreener query skipped: too short or blocked"
      );

      return null;
    }

    // Проверка кэша
    const cached = this.searchCache.get(normalizedQuery);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug(
        {
          query,
          normalizedQuery,
          cachedPair: cached.pair
            ? {
                chainId: cached.pair.chainId,
                pairAddress: cached.pair.pairAddress,
                baseSymbol: cached.pair.baseSymbol,
                quoteSymbol: cached.pair.quoteSymbol
              }
            : null
        },
        "DexScreener query served from cache"
      );
    
      return cached.pair;
    }
    const url =
      `${this.baseUrl}/search?q=` +
      encodeURIComponent(query);

    const payload =
      await this.fetchJsonWithRetry(
        url,
        query
      );

    if (!payload?.pairs?.length) {
      const result: DexPair | null = null;

      // Кэшируем отрицательный результат
      this.searchCache.set(normalizedQuery, {
        pair: result,
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS
      });

      return result;
    }

    const now = Date.now();

    const maxPairAgeMs =
      config.dexMaxPairAgeHours *
      3_600_000;

    const preferredChains =
      config.dexPreferredChains.map(
        (item) =>
          item.trim().toLowerCase()
      );

    const quotePriority =
      config.dexQuotePriority.map(
        (item) =>
          item.trim().toUpperCase()
      );

    const candidates =
      payload.pairs
        .filter((pair) => {
          const chainId =
            (
              pair.chainId ?? ""
            )
              .trim()
              .toLowerCase();

          const quoteSymbol =
            (
              pair.quoteToken?.symbol ??
              ""
            )
              .trim()
              .toUpperCase();

          const baseSymbol =
            (
              pair.baseToken?.symbol ??
              ""
            ).trim();

          const liquidityUsd =
            Number(
              pair.liquidity?.usd ?? 0
            );

          const volumeM5 =
            Number(
              pair.volume?.m5 ?? 0
            );

          const buysM5 =
            Number(
              pair.txns?.m5?.buys ?? 0
            );

          const sellsM5 =
            Number(
              pair.txns?.m5?.sells ?? 0
            );

          const priceUsd =
            Number(
              pair.priceUsd ?? 0
            );

          const pairCreatedAt =
            Number(
              pair.pairCreatedAt ?? 0
            );

          if (
            !preferredChains.includes(
              chainId
            )
          ) {
            return false;
          }

          if (
            !quotePriority.includes(
              quoteSymbol
            )
          ) {
            return false;
          }

          if (
            isBlockedBaseSymbol(
              baseSymbol
            )
          ) {
            return false;
          }

          if (
            normalizeSymbol(baseSymbol) !==
            normalizedQuery
          ) {
            return false;
          }

          if (
            liquidityUsd <
            config.dexMinLiquidityUsd
          ) {
            return false;
          }

          if (
            volumeM5 <
            config.dexMinVolumeM5Usd
          ) {
            return false;
          }

          if (
            buysM5 <
              config.minDexBuysSellsM5 ||
            sellsM5 <
              config.minDexBuysSellsM5
          ) {
            return false;
          }

          if (!(priceUsd > 0)) {
            return false;
          }

          if (
            pairCreatedAt > 0 &&
            now - pairCreatedAt >
              maxPairAgeMs
          ) {
            return false;
          }

          return true;
        })
        .map((pair): DexPair => ({
          chainId: (
            pair.chainId ?? ""
          )
            .trim()
            .toLowerCase(),

          dexId:
            pair.dexId ?? "",

          pairAddress:
            pair.pairAddress ?? "",

          baseTokenAddress:
            pair.baseToken?.address ?? "",

          quoteTokenAddress:
            pair.quoteToken?.address ?? "",

          baseSymbol:
            pair.baseToken?.symbol ?? "",

          quoteSymbol:
            pair.quoteToken?.symbol ?? "",

          liquidityUsd:
            Number(
              pair.liquidity?.usd ?? 0
            ),

          volumeM5:
            Number(
              pair.volume?.m5 ?? 0
            ),

          buysM5:
            Number(
              pair.txns?.m5?.buys ?? 0
            ),

          sellsM5:
            Number(
              pair.txns?.m5?.sells ?? 0
            ),

          priceUsd:
            Number(
              pair.priceUsd ?? 0
            ),

          pairCreatedAt:
            Number(
              pair.pairCreatedAt ?? 0
            )
        }))
        .sort((a, b) => {
          const quoteRankA =
            quotePriority.indexOf(
              a.quoteSymbol
                .trim()
                .toUpperCase()
            );

          const quoteRankB =
            quotePriority.indexOf(
              b.quoteSymbol
                .trim()
                .toUpperCase()
            );

          if (
            quoteRankA !== quoteRankB
          ) {
            return (
              quoteRankA -
              quoteRankB
            );
          }

          if (
            b.liquidityUsd !==
            a.liquidityUsd
          ) {
            return (
              b.liquidityUsd -
              a.liquidityUsd
            );
          }

          if (
            b.volumeM5 !==
            a.volumeM5
          ) {
            return (
              b.volumeM5 -
              a.volumeM5
            );
          }

          return (
            (b.pairCreatedAt ?? 0) -
            (a.pairCreatedAt ?? 0)
          );
        });

    const best =
      candidates[0] ?? null;

    // Кэшируем результат
    this.searchCache.set(normalizedQuery, {
      pair: best,
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS
    });

    return best;
  }

  async findBestPairAcrossChains(
    query: string
  ): Promise<DexPair | null> {
    const normalizedQuery =
      normalizeSymbol(query);

    if (
      !normalizedQuery ||
      isBlockedBaseSymbol(
        normalizedQuery
      )
    ) {
      return null;
    }

    let pair =
      await this.findPairByQuery(query);

    if (pair) {
      return pair;
    }

    const aliases =
      this.getQueryAliases(query);

    for (const alias of aliases) {
      pair =
        await this.findPairByQuery(
          alias
        );

      if (pair) {
        return pair;
      }
    }

    return null;
  }

  private getQueryAliases(
    query: string
  ): string[] {
    const base =
      query.toUpperCase();

    const aliases: string[] = [];

    if (base.startsWith("1000")) {
      aliases.push(base.slice(4));
    }

    if (base === "SOL") {
      aliases.push(
        "SOLANA",
        "WRAPPED-SOLANA"
      );
    }

    if (base === "BTC") {
      aliases.push(
        "BITCOIN",
        "WBTC"
      );
    }

    if (base === "ETH") {
      aliases.push(
        "ETHEREUM",
        "WETH"
      );
    }

    if (base === "BNB") {
      aliases.push("WBNB");
    }

    if (base === "MATIC") {
      aliases.push("WMATIC");
    }

    if (base === "AVAX") {
      aliases.push("WAVAX");
    }

    if (base === "FTM") {
      aliases.push("WFTM");
    }

    if (base === "PEPE") {
      aliases.push("PEPESOLANA");
    }

    if (base === "WIF") {
      aliases.push("WIFSOLANA");
    }

    if (base === "BONK") {
      aliases.push("BONKSOLANA");
    }

    return aliases;
  }

  async getPairByChainAndAddress(
    chainId: string,
    pairAddress: string
  ): Promise<DexPair | null> {
    const url =
      `${this.baseUrl}/pairs/` +
      `${encodeURIComponent(chainId)}/` +
      `${encodeURIComponent(pairAddress)}`;

    const payload =
      await this.fetchJsonWithRetry(
        url,
        `${chainId}/${pairAddress}`
      );

    const pair =
      payload?.pairs?.[0];

    if (!pair) {
      logger.warn(
        {
          chainId,
          pairAddress,
          url
        },
        "DexScreener pair endpoint returned no pair"
      );

      return null;
    }

    const priceUsd =
      Number(pair.priceUsd ?? 0);

    if (!(priceUsd > 0)) {
      logger.warn(
        {
          chainId,
          pairAddress,
          priceUsd
        },
        "DexScreener pair has invalid price"
      );

      return null;
    }

    const result: DexPair = {
      chainId: (
        pair.chainId ?? chainId
      )
        .trim()
        .toLowerCase(),

      dexId:
        pair.dexId ?? "",

      pairAddress:
        pair.pairAddress ??
        pairAddress,

      baseTokenAddress:
        pair.baseToken?.address ?? "",

      quoteTokenAddress:
        pair.quoteToken?.address ?? "",

      baseSymbol:
        pair.baseToken?.symbol ?? "",

      quoteSymbol:
        pair.quoteToken?.symbol ?? "",

      liquidityUsd:
        Number(
          pair.liquidity?.usd ?? 0
        ),

      volumeM5:
        Number(
          pair.volume?.m5 ?? 0
        ),

      buysM5:
        Number(
          pair.txns?.m5?.buys ?? 0
        ),

      sellsM5:
        Number(
          pair.txns?.m5?.sells ?? 0
        ),

      priceUsd,

      pairCreatedAt:
        Number(
          pair.pairCreatedAt ?? 0
        )
    };

    return result;
  }

  async getPairsByChainAndAddresses(
    chainId: string,
    pairAddresses: string[]
  ): Promise<Map<string, DexPair>> {
    const result =
      new Map<string, DexPair>();

    const uniqueAddresses = [
      ...new Set(
        pairAddresses
          .map((address) =>
            address.trim()
          )
          .filter(
            (address) =>
              address.length > 0
          )
      )
    ];

    if (uniqueAddresses.length === 0) {
      return result;
    }

    for (
      let offset = 0;
      offset < uniqueAddresses.length;
      offset +=
        MAX_PAIRS_PER_BATCH_REQUEST
    ) {
      const chunk =
        uniqueAddresses.slice(
          offset,
          offset +
            MAX_PAIRS_PER_BATCH_REQUEST
        );

      const url =
        `${this.baseUrl}/pairs/` +
        `${encodeURIComponent(chainId)}/` +
        chunk
          .map((address) =>
            encodeURIComponent(address)
          )
          .join(",");

      const payload =
        await this.fetchJsonWithRetry(
          url,
          `${chainId} batch ${chunk.length}`
        );

      if (!payload?.pairs?.length) {
        logger.warn(
          {
            chainId,
            requested:
              chunk.length,
            url
          },
          "DexScreener batch endpoint returned no pairs"
        );

        continue;
      }

      let matched = 0;

      for (const rawPair of payload.pairs) {
        const priceUsd =
          Number(
            rawPair.priceUsd ?? 0
          );

        const pairAddress =
          rawPair.pairAddress ?? "";

        if (
          !pairAddress ||
          !(priceUsd > 0)
        ) {
          continue;
        }

        result.set(
          pairAddress.toLowerCase(),
          {
            chainId: (
              rawPair.chainId ??
              chainId
            )
              .trim()
              .toLowerCase(),

            dexId:
              rawPair.dexId ?? "",

            pairAddress,

            baseTokenAddress:
              rawPair.baseToken
                ?.address ?? "",

            quoteTokenAddress:
              rawPair.quoteToken
                ?.address ?? "",

            baseSymbol:
              rawPair.baseToken
                ?.symbol ?? "",

            quoteSymbol:
              rawPair.quoteToken
                ?.symbol ?? "",

            liquidityUsd:
              Number(
                rawPair.liquidity
                  ?.usd ?? 0
              ),

            volumeM5:
              Number(
                rawPair.volume?.m5 ??
                  0
              ),

            buysM5:
              Number(
                rawPair.txns?.m5
                  ?.buys ?? 0
              ),

            sellsM5:
              Number(
                rawPair.txns?.m5
                  ?.sells ?? 0
              ),

            priceUsd,

            pairCreatedAt:
              Number(
                rawPair
                  .pairCreatedAt ??
                  0
              )
          }
        );

        matched += 1;
      }
    }

    return result;
  }
}
