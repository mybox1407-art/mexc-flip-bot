import "dotenv/config";

function requireEnv(
  name: string,
  fallback?: string
): string {
  const value = process.env[name] ?? fallback;

  if (value === undefined || value === "") {
    throw new Error(`Missing required env: ${name}`);
  }

  return value;
}

function numberEnv(
  name: string,
  fallback: number
): number {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid number env: ${name}=${raw}`
    );
  }

  return value;
}

function stringListEnv(
  name: string,
  fallback: string[]
): string[] {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  nodeEnv:
    process.env.NODE_ENV ?? "development",

  logLevel:
    process.env.LOG_LEVEL ?? "info",

  dataDir:
    process.env.DATA_DIR ?? "data",

  mexcRestUrl: requireEnv(
    "MEXC_REST_URL",
    "https://contract.mexc.com"
  ),

  mexcWsUrl: requireEnv(
    "MEXC_WS_URL",
    "wss://contract.mexc.com/edge"
  ),

  telegramBotToken:
    process.env.TELEGRAM_BOT_TOKEN,

  telegramChatId:
    process.env.TELEGRAM_CHAT_ID,

  contractPollMs: numberEnv(
    "CONTRACT_POLL_MS",
    60_000
  ),

  contractRefreshMs: numberEnv(
    "CONTRACT_REFRESH_MS",
    60_000
  ),

  contractLookbackHours: numberEnv(
    "CONTRACT_LOOKBACK_HOURS",
    72
  ),

  contractHotHours: numberEnv(
    "CONTRACT_HOT_HOURS",
    24
  ),

  contractHotRecheckMs: numberEnv(
    "CONTRACT_HOT_RECHECK_MS",
    5_000
  ),

  contractWarmRecheckMs: numberEnv(
    "CONTRACT_WARM_RECHECK_MS",
    30_000
  ),

  dexPollMs: numberEnv(
    "DEX_POLL_MS",
    2_000
  ),

  dexMaxPairAgeHours: numberEnv(
    "DEX_MAX_PAIR_AGE_HOURS",
    24
  ),

  dexQuotePriority: stringListEnv(
    "DEX_QUOTE_PRIORITY",
    ["USDC", "USDT", "SOL", "ETH"]
  ),

  minDexBuysSellsM5: numberEnv(
    "MIN_DEX_BUYS_SELLS_M5",
    10
  ),

  dexPreferredChains: stringListEnv(
    "DEX_PREFERRED_CHAINS",
    [
      "bsc",
      "base",
      "ethereum",
      "solana",
      "arbitrum",
      "ton",
      "polygon"
    ]
  ),

  dexMinLiquidityUsd: numberEnv(
    "DEX_MIN_LIQUIDITY_USD",
    20_000
  ),

  dexMinVolumeM5Usd: numberEnv(
    "DEX_MIN_VOLUME_M5_USD",
    1_000
  ),

  minMexcTurnover24h: numberEnv(
    "MIN_MEXC_TURNOVER_24H",
    200_000
  ),

  maxMexcBookSpreadPct: numberEnv(
    "MAX_MEXC_BOOK_SPREAD_PCT",
    0.35
  ),

  maxDexAnchorAgeMs: numberEnv(
    "MAX_DEX_ANCHOR_AGE_MS",
    5_000
  ),

  maxDexDriftPct: numberEnv(
    "MAX_DEX_DRIFT_PCT",
    0.6
  ),

  minSpreadPct: numberEnv(
    "MIN_SPREAD_PCT",
    1.2
  ),

  minNetEdgePct: numberEnv(
    "MIN_NET_EDGE_PCT",
    0.8
  ),

  assumedFeesPct: numberEnv(
    "ASSUMED_FEES_PCT",
    0.064
  ),

  assumedSlippagePct: numberEnv(
    "ASSUMED_SLIPPAGE_PCT",
    0.08
  ),

  mexcEntryFeePct: numberEnv(
    "MEXC_ENTRY_FEE_PCT",
    0.032
  ),

  mexcExitFeePct: numberEnv(
    "MEXC_EXIT_FEE_PCT",
    0.032
  ),

  mexcEntrySlippagePct: numberEnv(
    "MEXC_ENTRY_SLIPPAGE_PCT",
    0.04
  ),

  mexcExitSlippagePct: numberEnv(
    "MEXC_EXIT_SLIPPAGE_PCT",
    0.04
  ),

  latencyBufferPct: numberEnv(
    "LATENCY_BUFFER_PCT",
    0.02
  ),

  signalConfirmTicks: numberEnv(
    "SIGNAL_CONFIRM_TICKS",
    3
  ),

  signalCooldownMs: numberEnv(
    "SIGNAL_COOLDOWN_MS",
    180_000
  ),

  signalWindowMs: numberEnv(
    "SIGNAL_WINDOW_MS",
    30 * 60 * 1000
  ),

  signalMinTurnoverUsdt: numberEnv(
    "SIGNAL_MIN_TURNOVER_USDT",
    500_000
  ),

  signalMinMovePct: numberEnv(
    "SIGNAL_MIN_MOVE_PCT",
    1.0
  ),

  paperTradeUsdSize: numberEnv(
    "PAPER_TRADE_USD_SIZE",
    100
  ),

  paperExitSpreadPct: numberEnv(
    "PAPER_EXIT_SPREAD_PCT",
    0.25
  ),

  paperStopSpreadPct: numberEnv(
    "PAPER_STOP_SPREAD_PCT",
    0.7
  ),

  paperStopLossPct: numberEnv(
    "PAPER_STOP_LOSS_PCT",
    0.8
  ),

  paperMaxHoldMs: numberEnv(
    "PAPER_MAX_HOLD_MS",
    15 * 60 * 1000
  ),

  paperMaxAnchorMoveAgainstPct: numberEnv(
    "PAPER_MAX_ANCHOR_MOVE_AGAINST_PCT",
    1.0
  ),

  paperMaxDexPriceImpactPct: numberEnv(
    "PAPER_MAX_DEX_PRICE_IMPACT_PCT",
    2.0
  ),

  paperMaxLiquidityDropPct: numberEnv(
    "PAPER_MAX_LIQUIDITY_DROP_PCT",
    50
  ),

  startupBackfillCount: numberEnv(
    "STARTUP_BACKFILL_COUNT",
    20
  ),

  startupBackfillLimit: numberEnv(
    "STARTUP_BACKFILL_LIMIT",
    200
  ),

  startupLookbackHours: numberEnv(
    "STARTUP_LOOKBACK_HOURS",
    72
  ),

  rollingWindowRecheckMs: numberEnv(
    "ROLLING_WINDOW_RECHECK_MS",
    30 * 60 * 1000
  )
} as const;
