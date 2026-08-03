import { config } from "../config.js";

export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url?: string;
  pairCreatedAt?: number;

  baseSymbol: string;
  quoteSymbol: string;

  priceUsd: number;
  liquidityUsd: number;
  volumeM5: number;
  volumeH1: number;
  volumeH24: number;

  buysM5: number;
  sellsM5: number;
};

type DexSearchResponse = {
  pairs?: Array<{
    chainId?: string;
    dexId?: string;
    pairAddress?: string;
    url?: string;
    pairCreatedAt?: number;

    priceUsd?: string;

    baseToken?: {
      symbol?: string;
      name?: string;
      address?: string;
    };

    quoteToken?: {
      symbol?: string;
      name?: string;
      address?: string;
    };

    liquidity?: {
      usd?: number;
      base?: number;
      quote?: number;
    };

    volume?: {
      m5?: number;
      h1?: number;
      h6?: number;
      h24?: number;
    };

    txns?: {
      m5?: {
        buys?: number;
        sells?: number;
      };
    };
  }>;
};

function normalizeSymbol(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function hoursSince(ts?: number): number {
  if (!ts || ts <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return (Date.now() - ts) / 3_600_000;
}

function chainPriority(chainId: string): number {
  const idx = config.dexPreferredChains.indexOf(chainId);
  if (idx === -1) {
    return -100;
  }

  return (config.dexPreferredChains.length - idx) * 100;
}

function quotePriority(quoteSymbol: string): number {
  const idx = config.dexQuotePriority.indexOf(normalizeSymbol(quoteSymbol));
  if (idx === -1) {
    return 0;
  }

  return (config.dexQuotePriority.length - idx) * 20;
}

export class DexScreenerClient {
  private readonly baseUrl = "https://api.dexscreener.com/latest/dex/search";

  async findBestPairAcrossChains(baseCoin: string): Promise<DexPair | null> {
    const query = encodeURIComponent(baseCoin.trim());
    const response = await fetch(`${this.baseUrl}?q=${query}`);

    if (!response.ok) {
      throw new Error(`DexScreener search failed: ${response.status}`);
    }

    const data = (await response.json()) as DexSearchResponse;
    const pairs = data.pairs ?? [];

    const normalizedBase = normalizeSymbol(baseCoin);

    const candidates = pairs
      .map((pair) => this.toDexPair(pair))
      .filter((pair): pair is DexPair => pair !== null)
      .filter((pair) => config.dexPreferredChains.includes(pair.chainId))
      .filter((pair) => normalizeSymbol(pair.baseSymbol) === normalizedBase)
      .filter((pair) => pair.priceUsd > 0)
      .filter((pair) => pair.liquidityUsd >= config.dexMinLiquidityUsd)
      .filter((pair) => pair.volumeM5 >= config.dexMinVolume5mUsd)
      .filter((pair) => hoursSince(pair.pairCreatedAt) <= config.dexMaxPairAgeHours);

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => this.scorePair(b) - this.scorePair(a));

    return candidates[0] ?? null;
  }

  private toDexPair(pair: DexSearchResponse["pairs"][number]): DexPair | null {
    const chainId = String(pair.chainId ?? "").toLowerCase();
    const dexId = String(pair.dexId ?? "").toLowerCase();
    const pairAddress = String(pair.pairAddress ?? "");
    const baseSymbol = String(pair.baseToken?.symbol ?? "").trim();
    const quoteSymbol = String(pair.quoteToken?.symbol ?? "").trim();

    const priceUsd = Number(pair.priceUsd ?? 0);
    const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
    const volumeM5 = Number(pair.volume?.m5 ?? 0);
    const volumeH1 = Number(pair.volume?.h1 ?? 0);
    const volumeH24 = Number(pair.volume?.h24 ?? 0);
    const buysM5 = Number(pair.txns?.m5?.buys ?? 0);
    const sellsM5 = Number(pair.txns?.m5?.sells ?? 0);

    if (!chainId || !dexId || !pairAddress || !baseSymbol || !quoteSymbol) {
      return null;
    }

    return {
      chainId,
      dexId,
      pairAddress,
      url: pair.url,
      pairCreatedAt: pair.pairCreatedAt,

      baseSymbol,
      quoteSymbol,

      priceUsd,
      liquidityUsd,
      volumeM5,
      volumeH1,
      volumeH24,

      buysM5,
      sellsM5
    };
  }

  private scorePair(pair: DexPair): number {
    const liquidityScore = Math.min(pair.liquidityUsd / 1_000, 500);
    const volumeScore = Math.min(pair.volumeM5 / 500, 200);
    const freshnessPenalty = Math.min(hoursSince(pair.pairCreatedAt), 720) * 0.15;
    const activityScore = Math.min(pair.buysM5 + pair.sellsM5, 100);
    const quoteScore = quotePriority(pair.quoteSymbol);
    const chainScore = chainPriority(pair.chainId);

    return (
      liquidityScore +
      volumeScore +
      activityScore +
      quoteScore +
      chainScore -
      freshnessPenalty
    );
  }
}
