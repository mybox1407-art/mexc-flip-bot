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

export class DexScreenerClient {
  private readonly baseUrl =
    "https://api.dexscreener.com/latest/dex";

  private requestCounter = 0;

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
        logger.debug(
          {
            requestId,
            attempt,
            url,
            query
          },
          "DexScreener request started"
        );

        const response =
          await fetch(url);

        const durationMs =
          Date.now() - startedAt;

        const retryAfter =
          response.headers.get(
            "retry-after"
          );

        logger.debug(
          {
            requestId,
            attempt,
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            durationMs,
            retryAfter,
            url,
            query
          },
          "DexScreener response received"
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

        logger.debug(
          {
            requestId,
            attempt,
            pairCount:
              payload.pairs?.length ?? 0,
            url,
            query,
            durationMs
          },
          "DexScreener payload parsed"
        );

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

    if (
      !normalizedQuery ||
      isBlockedBaseSymbol(
        normalizedQuery
      )
    ) {
      logger.debug(
        {
          query,
          normalizedQuery
        },
        "DexScreener query skipped"
      );

      return null;
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
      logger.info(
        {
          query,
          url,
          receivedPairs:
            payload?.pairs?.length ?? 0
        },
        "DexScreener returned no pairs"
      );

      return null;
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

    logger.info(
      {
        query,
        receivedPairs:
          payload.pairs.length,
        validCandidates:
          candidates.length,

        selectedPair: best
          ? {
              chainId: best.chainId,
              dexId: best.dexId,
              pairAddress:
                best.pairAddress,
              baseSymbol:
                best.baseSymbol,
              quoteSymbol:
                best.quoteSymbol,
              liquidityUsd:
                best.liquidityUsd,
              volumeM5:
                best.volumeM5,
              buysM5:
                best.buysM5,
              sellsM5:
                best.sellsM5,
              priceUsd:
                best.priceUsd
            }
          : null
      },
      "DexScreener pair selection completed"
    );

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
      logger.debug(
        {
          query,
          normalizedQuery
        },
        "DexScreener lookup skipped"
      );

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
        logger.info(
          {
            query,
            alias,
            chainId: pair.chainId,
            dexId: pair.dexId,
            pairAddress:
              pair.pairAddress
          },
          "DexScreener pair found by alias"
        );

        return pair;
      }
    }

    logger.warn(
      {
        query,
        aliases
      },
      "DexScreener pair not found across chains"
    );

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

    logger.debug(
      {
        chainId,
        pairAddress,
        result
      },
      "DexScreener pair fetched"
    );

    return result;
  }
}
