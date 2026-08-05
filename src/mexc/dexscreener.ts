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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSymbol(value: string): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-\/\s]/g, "");
}

function isBlockedBaseSymbol(symbol: string): boolean {
  const upper = symbol.toUpperCase();

  // Точное совпадение, а не фрагменты
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
  private readonly baseUrl = "https://api.dexscreener.com/latest/dex";
  private lastRequestAt = 0;
  private readonly minRequestGapMs = 450;

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = this.lastRequestAt + this.minRequestGapMs - now;

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    this.lastRequestAt = Date.now();
  }

  private async fetchJsonWithRetry(url: string, query?: string): Promise<DexSearchResponse | null> {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await this.throttle();

      const response = await fetch(url);

      if (response.status === 429) {
        const backoffMs = attempt * 2500;

        logger.warn(
          { url, attempt, backoffMs },
          "DexScreener rate limited, backing off"
        );

        await sleep(backoffMs);
        continue;
      }

      if (response.status === 400) {
        logger.warn(
          { url, query },
          "DexScreener returned 400, skipping"
        );
        return null;
      }

      if (!response.ok) {
        throw new Error(`DexScreener search failed: ${response.status}`);
      }

      return (await response.json()) as DexSearchResponse;
    }

    throw new Error("DexScreener search failed: 429");
  }

  private async findPairByQuery(query: string): Promise<DexPair | null> {
    const normalizedQuery = normalizeSymbol(query);

    if (!normalizedQuery || isBlockedBaseSymbol(normalizedQuery)) {
      logger.debug({ query, normalizedQuery }, "Query blocked or empty");
      return null;
    }

    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
    logger.debug({ query, url }, "Searching DEX pair");
    
    const payload = await this.fetchJsonWithRetry(url, query);

    if (!payload || !payload.pairs) {
      logger.debug({ query, url }, "No pairs returned from search");
      return null;
    }

    const pairs = payload.pairs;
    const now = Date.now();
    const maxPairAgeMs = config.dexMaxPairAgeHours * 3_600_000;

    const candidates = pairs
      .filter((pair) => {
        const chainId = (pair.chainId ?? "").toLowerCase();
        const quoteSymbol = (pair.quoteToken?.symbol ?? "").toLowerCase();
        const baseSymbol = pair.baseToken?.symbol ?? "";
        const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
        const volumeM5 = Number(pair.volume?.m5 ?? 0);
        const buysM5 = Number(pair.txns?.m5?.buys ?? 0);
        const sellsM5 = Number(pair.txns?.m5?.sells ?? 0);
        const priceUsd = Number(pair.priceUsd ?? 0);
        const pairCreatedAt = Number(pair.pairCreatedAt ?? 0);

        if (!config.dexPreferredChains.includes(chainId)) {
          return false;
        }

        if (!config.dexQuotePriority.includes(quoteSymbol)) {
          return false;
        }

        if (isBlockedBaseSymbol(baseSymbol)) {
          return false;
        }

        if (normalizeSymbol(baseSymbol) !== normalizedQuery) {
          return false;
        }

        if (liquidityUsd < config.dexMinLiquidityUsd) {
          return false;
        }

        if (volumeM5 < config.dexMinVolumeM5Usd) {
          return false;
        }

        if (buysM5 + sellsM5 < config.minDexBuysSellsM5) {
          return false;
        }

        if (!(priceUsd > 0)) {
          return false;
        }

        if (pairCreatedAt > 0 && now - pairCreatedAt > maxPairAgeMs) {
          return false;
        }

        return true;
      })
      .map((pair) => ({
        chainId: (pair.chainId ?? "").toLowerCase(),
        dexId: pair.dexId ?? "",
        pairAddress: pair.pairAddress ?? "",
        baseTokenAddress: pair.baseToken?.address ?? "",
        quoteTokenAddress: pair.quoteToken?.address ?? "",
        baseSymbol: pair.baseToken?.symbol ?? "",
        quoteSymbol: pair.quoteToken?.symbol ?? "",
        liquidityUsd: Number(pair.liquidity?.usd ?? 0),
        volumeM5: Number(pair.volume?.m5 ?? 0),
        buysM5: Number(pair.txns?.m5?.buys ?? 0),
        sellsM5: Number(pair.txns?.m5?.sells ?? 0),
        priceUsd: Number(pair.priceUsd ?? 0),
        pairCreatedAt: Number(pair.pairCreatedAt ?? 0)
      }))
      .sort((a, b) => {
        const quoteRankA = config.dexQuotePriority.indexOf(a.quoteSymbol.toLowerCase());
        const quoteRankB = config.dexQuotePriority.indexOf(b.quoteSymbol.toLowerCase());

        if (quoteRankA !== quoteRankB) {
          return quoteRankA - quoteRankB;
        }

        if (b.liquidityUsd !== a.liquidityUsd) {
          return b.liquidityUsd - a.liquidityUsd;
        }

        if (b.volumeM5 !== a.volumeM5) {
          return b.volumeM5 - a.volumeM5;
        }

        return (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0);
      });

    const best = candidates[0] ?? null;

    if (!best) {
      logger.debug({ query }, "DexScreener returned no valid pairs");
      return null;
    }

    logger.debug(
      {
        query,
        chainId: best.chainId,
        dexId: best.dexId,
        quoteSymbol: best.quoteSymbol,
        liquidityUsd: best.liquidityUsd.toFixed(0),
        volumeM5: best.volumeM5.toFixed(0),
        priceUsd: best.priceUsd.toFixed(6)
      },
      "DexScreener best pair selected"
    );

    return best;
  }

  async findBestPairAcrossChains(query: string): Promise<DexPair | null> {
    const normalizedQuery = normalizeSymbol(query);

    if (!normalizedQuery || isBlockedBaseSymbol(normalizedQuery)) {
      logger.debug({ query, normalizedQuery }, "Query blocked or empty");
      return null;
    }

    logger.info({ query, normalizedQuery }, "findBestPairAcrossChains called");

    // 1. Пробуем по основному query
    let pair = await this.findPairByQuery(query);
    if (pair) {
      logger.info({ query, success: true }, "Found pair on first attempt");
      return pair;
    }

    // 2. Fallback по алиасам
    const aliases = this.getQueryAliases(query);
    for (const alias of aliases) {
      logger.debug({ query, alias }, "Trying alias");
      pair = await this.findPairByQuery(alias);
      if (pair) {
        logger.info({ query, alias, success: true }, "Found pair via alias");
        return pair;
      }
    }

    logger.info({ query, aliases: aliases.length }, "No pair found");
    return null;
  }

  private getQueryAliases(query: string): string[] {
    const base = query.toUpperCase();
    const aliases: string[] = [];

    // Токены с префиксами
    if (base.startsWith("1000")) {
      aliases.push(base.slice(4)); // 1000BONK → BONK
    }

    // Обёртки
    if (base === "SOL") aliases.push("SOLANA", "WRAPPED-SOLANA");
    if (base === "BTC") aliases.push("BITCOIN", "WBTC");
    if (base === "ETH") aliases.push("ETHEREUM", "WETH");
    if (base === "BNB") aliases.push("WBNB");
    if (base === "MATIC") aliases.push("WMATIC");
    if (base === "AVAX") aliases.push("WAVAX");
    if (base === "FTM") aliases.push("WFTM");

    // Мемы
    if (base === "PEPE") aliases.push("PEPESOLANA");
    if (base === "WIF") aliases.push("WIFSOLANA");
    if (base === "BONK") aliases.push("BONKSOLANA");

    return aliases;
  }

  async getPairByChainAndAddress(
    chainId: string,
    pairAddress: string
  ): Promise<DexPair | null> {
    const url = `${this.baseUrl}/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
    
    logger.debug({ chainId, pairAddress }, "getPairByChainAndAddress called");
    
    const payload = await this.fetchJsonWithRetry(url);
    
    const pair = payload?.pairs?.[0];

    if (!pair) {
      logger.warn({ chainId, pairAddress }, "No pair returned from DexScreener");
      return null;
    }

    const priceUsd = Number(pair.priceUsd ?? 0);

    if (!(priceUsd > 0)) {
      logger.warn({ chainId, pairAddress, priceUsd }, "Invalid priceUsd");
      return null;
    }

    logger.debug(
      {
        chainId,
        pairAddress,
        symbol: pair.baseToken?.symbol,
        priceUsd: priceUsd.toFixed(6),
        liquidity: Number(pair.liquidity?.usd ?? 0).toFixed(0)
      },
      "DEX pair fetched successfully"
    );

    return {
      chainId: (pair.chainId ?? "").toLowerCase(),
      dexId: pair.dexId ?? "",
      pairAddress: pair.pairAddress ?? "",
      baseTokenAddress: pair.baseToken?.address ?? "",
      quoteTokenAddress: pair.quoteToken?.address ?? "",
      baseSymbol: pair.baseToken?.symbol ?? "",
      quoteSymbol: pair.quoteToken?.symbol ?? "",
      liquidityUsd: Number(pair.liquidity?.usd ?? 0),
      volumeM5: Number(pair.volume?.m5 ?? 0),
      buysM5: Number(pair.txns?.m5?.buys ?? 0),
      sellsM5: Number(pair.txns?.m5?.sells ?? 0),
      priceUsd,
      pairCreatedAt: Number(pair.pairCreatedAt ?? 0)
    };
  }
}
