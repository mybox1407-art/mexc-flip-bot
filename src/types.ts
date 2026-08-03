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
  detectedAt: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  spreadPct: number;
  netEdgePct: number;
  priceDeviationPct: number;
  dexPrice: number;
  mexcPrice: number;
  mexcBid: number;
  mexcAsk: number;
  mexcTurnover24h: number;
  dexLiquidityUsd: number;
  dexVolumeM5: number;
  dexBuysM5: number;
  dexSellsM5: number;
  dexId: string;
  chainId: string;
  quoteSymbol: string;
  dexPairAddress: string;
  entryRef: "ASK" | "BID";
  mexcBookSpreadPct: number;
  anchorAgeMs: number;
  dexDriftPct: number;
  confirmCount: number;
  reason: string;
}

export interface PaperTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt?: string;
  entryPrice: number;
  exitPrice?: number;
  entryRef: "ASK" | "BID";
  exitRef?: "ASK" | "BID";
  qtyUsd: number;
  qtyToken: number;
  dexAnchorAtEntry: number;
  dexAnchorAtExit?: number;
  entrySpreadPct: number;
  exitSpreadPct?: number;
  grossPnlPct?: number;
  netPnlPct?: number;
  grossPnlUsd?: number;
  netPnlUsd?: number;
  holdMs?: number;
  openReason: string;
  closeReason?: string;
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
