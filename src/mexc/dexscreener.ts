import { config } from "../config.js";
import { logger } from "../logger.js";

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  volumeM5: number;
  volumeH1: number;
  baseTokenSymbol: string;
  baseTokenAddress: string;
  quoteTokenSymbol: string;
  pairCreatedAt: number;
}

interface RawDexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number };
  baseToken?: { symbol?: string; address?: string };
  quoteToken?: { symbol?: string };
  pairCreatedAt?: number;
}

interface SearchResponse {
  pairs?: RawDexPair[];
}

interface TokensResponse {
  pairs?: RawDexPair[];
}

const BASE_URL = "https://api.dexscreener.com";

function toDexPair(raw: RawDexPair): DexPair | null {
  if (!raw.pairAddress || !raw.baseToken?.address) {
    return null;
  }

  return {
    chainId: raw.chainId ?? "",
    dexId: raw.dexId ?? "",
    pairAddress: raw.pairAddress,
    priceUsd: Number(raw.priceUsd ?? 0),
    liquidityUsd: Number(raw.liquidity?.usd ?? 0),
    volumeM5: Number(raw.volume?.m5 ?? 0),
    volumeH1: Number(raw.volume?.h1 ?? 0),
    baseTokenSymbol: raw.baseToken.symbol ?? "",
    baseTokenAddress: raw.baseToken.address,
    quoteTokenSymbol: raw.quoteToken?.symbol ?? "",
    pairCreatedAt: raw.pairCreatedAt ?? 0
  };
}

export class DexScreenerClient {
  private lastRequestAt = 0;
  private readonly minIntervalMs = 300; // не более ~200 req/min

  private async fetchJson<T>(url: string): Promise<T | null> {
    const now = Date.now();
    const wait = this.minIntervalMs - (now - this.lastRequestAt);

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    this.lastRequestAt = Date.now();

    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000)
      });

      if (response.status === 429) {
        logger.warn("DexScreener rate limit hit, backing off");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return null;
      }

      if (!response.ok) {
        logger.warn({ status: response.status, url }, "DexScreener request failed");
        return null;
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.warn({ err: error, url }, "DexScreener request error");
      return null;
    }
  }

  async findBestSolanaPair(symbol: string): Promise<DexPair | null> {
    const data = await this.fetchJson<SearchResponse>(
      `${BASE_URL}/latest/dex/search?q=${encodeURIComponent(symbol)}`
    );

    if (!data?.pairs) {
      return null;
    }

    const candidates = data.pairs
      .map(toDexPair)
      .filter((pair): pair is DexPair => pair !== null)
      .filter(
        (pair) =>
          pair.chainId === "solana" &&
          pair.baseTokenSymbol.toUpperCase() === symbol.toUpperCase() &&
          pair.priceUsd > 0 &&
          pair.liquidityUsd >= config.dexMinLiquidityUsd &&
          (pair.quoteTokenSymbol === "SOL" || pair.quoteTokenSymbol === "USDC")
      );

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    return candidates[0];
  }

  async getPairsByTokenAddresses(addresses: string[]): Promise<Map<string, DexPair>> {
    const result = new Map<string, DexPair>();

    if (addresses.length === 0) {
      return result;
    }

    const chunk = addresses.slice(0, 30);
    const data = await this.fetchJson<TokensResponse>(
      `${BASE_URL}/latest/dex/tokens/${chunk.join(",")}`
    );

    if (!data?.pairs) {
      return result;
    }

    for (const raw of data.pairs) {
      const pair = toDexPair(raw);

      if (!pair) {
        continue;
      }

      const existing = result.get(pair.baseTokenAddress);

      if (!existing || pair.liquidityUsd > existing.liquidityUsd) {
        result.set(pair.baseTokenAddress, pair);
      }
    }

    return result;
  }
}
