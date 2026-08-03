export interface MexcContract {
  symbol: string;
  displayName?: string;
  baseCoin?: string;
  quoteCoin?: string;
  settleCoin?: string;
  contractSize?: number;
  priceUnit?: number;
  volUnit?: number;
  minVol?: number;
  maxLeverage?: number;
  [key: string]: unknown;
}

export interface MexcTicker {
  symbol: string;
  timestamp: number;
  lastPrice: number;
  volume24: number;
  amount24: number;
  riseFallRate: number;
  fairPrice: number;
  indexPrice: number;
  maxBidPrice: number;
  minAskPrice: number;
  lower24Price: number;
  high24Price: number;
}

export interface PricePoint {
  price: number;
  timestamp: number;
}

export interface FlipSignal {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  detectedAt: string;
  currentPrice: number;
  referencePrice: number;
  movePct: number;
  turnover24h: number;
  bid: number;
  ask: number;
  spreadPct: number;
  reason: string;
}

export interface ContractWatchState {
  symbol: string;
  firstSeenAt: number;
  lastCheckedAt: number | null;
  lastMappedAt: number | null;
  checksCount: number;
}

export interface CsvRow {
  [key: string]: string | number | boolean | null | undefined;
}
