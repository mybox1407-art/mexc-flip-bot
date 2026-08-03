import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }

  return value;
}

function stringListEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",

  mexcRestUrl: required("MEXC_REST_URL", "https://api.mexc.com"),
  mexcWsUrl: required("MEXC_WS_URL", "wss://contract.mexc.com/edge"),

  dataDir: required("DATA_DIR", "./data"),

  contractRefreshMs: numberEnv("CONTRACT_REFRESH_MS", 60_000),
  signalWindowMs: numberEnv("SIGNAL_WINDOW_MS", 30_000),
  signalMinMovePct: numberEnv("SIGNAL_MIN_MOVE_PCT", 2),
  signalMinTurnoverUsdt: numberEnv("SIGNAL_MIN_TURNOVER_USDT", 100_000),
  maxTrackedNewContracts: numberEnv("MAX_TRACKED_NEW_CONTRACTS", 10),

  dexPollMs: numberEnv("DEX_POLL_MS", 2_000),
  dexMinLiquidityUsd: numberEnv("DEX_MIN_LIQUIDITY_USD", 50_000),
  dexMinVolumeM5Usd: numberEnv("DEX_MIN_VOLUME_M5_USD", 5_000),
  dexMaxPairAgeHours: numberEnv("DEX_MAX_PAIR_AGE_HOURS", 24 * 30),

  minSpreadPct: numberEnv("MIN_SPREAD_PCT", 0.8),
  signalCooldownMs: numberEnv("SIGNAL_COOLDOWN_MS", 60_000),

  dexPreferredChains: stringListEnv("DEX_PREFERRED_CHAINS", [
    "bsc",
    "base",
    "ethereum",
    "solana",
    "arbitrum",
    "ton",
    "polygon"
  ]),

  dexQuotePriority: stringListEnv("DEX_QUOTE_PRIORITY", [
    "usdt",
    "usdc",
    "weth",
    "wbnb",
    "sol",
    "ton"
  ])
};
