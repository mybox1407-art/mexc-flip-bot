import { config } from "../config.js";

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url?: string;
  pairCreatedAt?: number;

  baseTokenAddress: string;
  baseSymbol: string;
  quoteTokenAddress: string;
  quoteSymbol: string;

  priceUsd: number;
  liquidityUsd: number;
  volumeM5: number;
  volumeH1: number;
  volumeH24: number;

  buysM5: number;
  sellsM5: number;
}

interface DexScreenerSearchResponse {
  pairs?: DexScreenerPairResponse[];
}

interface DexScreenerPairResponse {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  priceUsd?: string;

  baseToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };

  quoteToken?: {
    address?: string;
    name?: string;
    symbol?: string;
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
}

function normalizeSymbol(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getPairAgeHours(pairCreatedAt?: number): number {
  if (!pairCreatedAt || pairCreatedAt <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return (Date.now() - pairCreatedAt) / 3_600_000;
}

function getChainPriority(chainId: string): number {
  const index = config.dexPreferredChains.indexOf(chainId);

  if (index === -1) {
    return -1000;
  }

  return (config.dexPreferredChains.length - index) * 100;
}

function getQuotePriority(quoteSymbol: string): number {
  const normalized = normalizeSymbol(quoteSymbol);
  const index = config.dexQuotePriority.indexOf(normalized);

  if (index === -1) {
    return 0;
  }

  return (config.dexQuotePriority.length - index) * 20;
}

export class DexScreenerClient {
  private readonly baseUrl = "https://api.dexscreener.com/latest/dex/search";

  async findBestPairAcrossChains(baseCoin: string): Promise<DexPair | null> {
    const query = encodeURIComponent(baseCoin.trim());
    const response = await fetch(`${this.baseUrl}?q=${query}`);

    if (!response.ok) {
      throw new Error(`DexScreener search failed: ${response.status}`);
    }

    const data = (await response.json()) as DexScreenerSearchResponse;
    const normalizedBaseCoin = normalizeSymbol(baseCoin);

    const candidates = (data.pairs ?? [])
      .map((pair) => this.mapPair(pair))
      .filter((pair): pair is DexPair => pair !== null)
      .filter((pair) => config.dexPreferredChains.includes(pair.chainId))
      .filter((pair) => normalizeSymbol(pair.baseSymbol) === normalizedBaseCoin)
      .filter((pair) => pair.priceUsd > 0)
      .filter((pair) => pair.liquidityUsd >= config.dexMinLiquidityUsd)
      .filter((pair) => pair.volumeM5 >= config.dexMinVolumeM5Usd)
      .filter((pair) => getPairAgeHours(pair.pairCreatedAt) <= config.dexMaxPairAgeHours);

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => this.scorePair(b) - this.scorePair(a));

    return candidates[0] ?? null;
  }

  private mapPair(pair: DexScreenerPairResponse): DexPair | null {
    const chainId = String(pair.chainId ?? "").trim().toLowerCase();
    const dexId = String(pair.dexId ?? "").trim().toLowerCase();
    const pairAddress = String(pair.pairAddress ?? "").trim();

    const baseTokenAddress = String(pair.baseToken?.address ?? "").trim();
    const baseSymbol = String(pair.baseToken?.symbol ?? "").trim();
    const quoteTokenAddress = String(pair.quoteToken?.address ?? "").trim();
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

      baseTokenAddress,
      baseSymbol,
      quoteTokenAddress,
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
    const chainScore = getChainPriority(pair.chainId);
    const quoteScore = getQuotePriority(pair.quoteSymbol);
    const liquidityScore = Math.min(pair.liquidityUsd / 1_000, 500);
    const volumeScore = Math.min(pair.volumeM5 / 500, 200);
    const activityScore = Math.min(pair.buysM5 + pair.sellsM5, 100);
    const agePenalty = Math.min(getPairAgeHours(pair.pairCreatedAt), 720) * 0.15;

    return chainScore + quoteScore + liquidityScore + volumeScore + activityScore - agePenalty;
  }
}
