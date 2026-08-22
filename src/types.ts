export interface MexcContract {
  contractId?: number | string;
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
  bid1: number;
  ask1: number;
}

export interface PricePoint {
  price: number;
  timestamp: number;
}

export type CloseReason =
  | "mean_reverted_profit"
  | "mean_reverted_loss"
  | "stop_loss"
  | "trailing_stop"
  | "timeout"
  | "anchor_moved_against_position"
  | "anchor_stale"
  | "liquidity_drop";

export interface FlipSignal {
  id: string;
  detectedAt: string;
  symbol: string;
  direction: "LONG" | "SHORT";

  spreadPct: number;
  netEdgePct: number;
  priceDeviationPct: number;

  currentPrice: number;
  referencePrice: number;
  movePct: number;

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
  dexUpdatedAt: number;
  dexDriftPct: number;
  dexDirectionalDriftPct: number;

  // OLS-наклон DEX цены, % в минуту.
  dexTrendSlopePct?: number;

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

  entryMexcBid?: number;
  entryMexcAsk?: number;
  entryMexcBookSpreadPct?: number;

  exitRef?: "ASK" | "BID";

  exitMexcBid?: number;
  exitMexcAsk?: number;
  exitMexcBookSpreadPct?: number;

  qtyUsd: number;
  qtyToken: number;

  depositAtEntry: number;

  // 0.3 = 30%, 0.003 = 0.3%
  allocationPct: number;

  depositAfterClose?: number;

  dexAnchorAtEntry: number;
  dexAnchorAtExit?: number;

  dexSnapshotAtEntry?: number;
  dexSnapshotAtExit?: number;

  entrySpreadPct: number;
  exitSpreadPct?: number;

  stopPrice?: number;
  stopDistancePct?: number;
  stopTriggerPrice?: number;
  marketExitPrice?: number;
  stopSlippagePct?: number;

  // NEW: trailing stop state
  trailActive?: boolean;
  trailBestPrice?: number;
  trailTriggerPct?: number;
  trailDistancePct?: number;

  grossPnlPct?: number;
  netPnlPct?: number;

  grossPnlUsd?: number;
  netPnlUsd?: number;

  holdMs?: number;

  openReason: string;
  closeReason?: CloseReason;
}

export interface ContractWatchState {
  symbol: string;
  firstSeenAt: number;
  lastCheckedAt: number | null;
  lastMappedAt: number | null;
  checksCount: number;
}

export interface CsvRow {
  [key: string]:
    | string
    | number
    | boolean
    | null
    | undefined;
}
