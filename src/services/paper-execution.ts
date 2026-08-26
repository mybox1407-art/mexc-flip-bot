import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { CloseReason, FlipSignal, MexcTicker, PaperTrade } from "../types.js";
import type { AnchorStatus } from "./spread-engine.js";

type PaperAction = { action: "OPEN" | "CLOSE"; trade: PaperTrade };
type Direction = "LONG" | "SHORT";

const MAX_ENTRY_SPREAD_PCT = 4.5;
const MIN_NET_PROFIT_PCT = 0.1;

const LOSS_COOLDOWN_MS = 15 * 60 * 1000;
const SMALL_PROFIT_COOLDOWN_MS = 3 * 60 * 1000;
const PROFIT_COOLDOWN_MS = 5 * 60 * 1000;
const TIMEOUT_COOLDOWN_MS = 10 * 60 * 1000;

const MAX_CONSECUTIVE_STOPS = 2;
const SYMBOL_BAN_DURATION_MS = 2 * 60 * 60 * 1000;

const INITIAL_STOP_DURATION_MS = 30 * 1000;
const INITIAL_STOP_DISTANCE_PCT = 0.4;
const REGULAR_STOP_DISTANCE_PCT = 0.6;

const ANCHOR_BREAK_DISTANCE_PCT = 0.4;
const MAX_ANCHOR_BREAK_LOSS_PCT = 0.5;
const ANCHOR_LOSS_MIN_HOLD_MS = 3 * 1000;

const MAX_ENTRY_MEXC_BOOK_SPREAD_PCT = 0.15;

const ENTRY_MOMENTUM_WINDOW_MS = 30 * 1000;
const ENTRY_MOMENTUM_MIN_SAMPLE_AGE_MS = 20 * 1000;
const LONG_ENTRY_MOMENTUM_BLOCK_PCT = 0.05;
const SHORT_ENTRY_MOMENTUM_BLOCK_PCT = 0.15;
const PRICE_HISTORY_TTL_MS = 90 * 1000;

const MAX_EXIT_SPREAD_PCT = 1.0;
const ANCHOR_REVERSAL_CONFIRMATIONS = 2;

interface SymbolRiskState {
  consecutiveStops: number;
  cooldownUntil: number;
  bannedUntil: number;
  anchorLosses: number;
  reversalConfirmations: number;
  lastAnchorMovePct?: number;
}

interface PriceSample {
  timestamp: number;
  mid: number;
}

interface EntryDiagnostics {
  entryCheckedAt: number;
  entryAnchorAgeMs: number;
  entryAnchorIsFresh: boolean;
  entryDexUpdatedAt: number;
  entryDexPrice: number;
  entryMexcBid: number;
  entryMexcAsk: number;
  entryMexcMid: number;
  entryMexcBookSpreadPct: number;
  entrySpreadPct: number;
  entryNetEdgePct: number;
  entryDexDriftPct: number;
  entryDexDirectionalDriftPct: number;
  entryDexTrendSlopePct: number;
  entryMomentumPct: number;
  entryMomentumBlocked: boolean;
  entryMomentumWindowMs: number;
  maxEntrySpreadPct: number;
  maxEntryMexcBookSpreadPct: number;
  maxEntryAnchorAgeMs: number;
  anchorBreakDistancePct: number;
  maxAnchorBreakLossPct: number;
  anchorLossMinHoldMs: number;
  initialStopDistancePct: number;
  initialStopPrice: number;
}

const normalizeSymbol = (v: string) =>
  String(v).trim().toUpperCase().replace(/[_\-/\s]/g, "");

const round = (v: number, d = 6) =>
  Math.round(v * 10 ** d) / 10 ** d;

const isFinitePositive = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v > 0;

export class PaperExecutionService {
  private readonly openTrades =
    new Map<string, PaperTrade>();

  private readonly processedCloseTrades =
    new Set<string>();

  private readonly liquidityAtEntry =
    new Map<string, number>();

  private readonly symbolRisk =
    new Map<string, SymbolRiskState>();

  private readonly priceHistory =
    new Map<string, PriceSample[]>();

  private readonly entryDiagnostics =
    new Map<string, EntryDiagnostics>();

  private readonly maxOpenTrades = 3;
  private readonly tradeAllocationPct = 0.3;

  private depositUsd = 100;

  getDepositUsd() {
    return round(this.depositUsd, 4);
  }

  getOpenTradesCount() {
    return this.openTrades.size;
  }

  recordTicker(ticker: MexcTicker) {
    const key = normalizeSymbol(ticker.symbol);

    this.recordPriceSample(
      key,
      Number(ticker.bid1),
      Number(ticker.ask1),
      Date.now()
    );
  }

  private skipSignal(
    signal: FlipSignal,
    skipReason: string,
    details: Record<string, unknown> = {}
  ): null {
    logger.warn(
      {
        symbol: signal.symbol,
        direction: signal.direction,
        signalReason: signal.reason,
        spreadPct: round(signal.spreadPct, 4),
        netEdgePct: round(signal.netEdgePct, 4),
        dexPrice: signal.dexPrice,
        mexcBid: signal.mexcBid,
        mexcAsk: signal.mexcAsk,
        skipReason,
        ...details
      },
      "SIGNAL SKIPPED"
    );

    return null;
  }

  private getTotalCostsPct() {
    return config.roundTripCostPct;
  }

  private getUsedCapitalUsd() {
    return [...this.openTrades.values()]
      .reduce((sum, trade) => sum + trade.qtyUsd, 0);
  }

  private getMaxTotalExposureUsd() {
    return this.depositUsd *
      config.paperMaxTotalExposurePct;
  }

  private getStopDistancePct(holdMs = 0) {
    return holdMs < INITIAL_STOP_DURATION_MS
      ? INITIAL_STOP_DISTANCE_PCT
      : REGULAR_STOP_DISTANCE_PCT;
  }

  private getStopSlippagePct() {
    return config.paperStopSlippagePct;
  }

  private getMinHoldMs() {
    return config.paperMinHoldMs;
  }

  private getTrailingTriggerPct() {
    return config.paperTrailingTriggerPct;
  }

  private getTrailingDistancePct() {
    return config.paperTrailingDistancePct;
  }

  private getSymbolRiskState(key: string) {
    let state = this.symbolRisk.get(key);

    if (!state) {
      state = {
        consecutiveStops: 0,
        cooldownUntil: 0,
        bannedUntil: 0,
        anchorLosses: 0,
        reversalConfirmations: 0
      };

      this.symbolRisk.set(key, state);
    }

    return state;
  }

  private recordPriceSample(
    key: string,
    bid: number,
    ask: number,
    timestamp: number
  ) {
    if (
      !isFinitePositive(bid) ||
      !isFinitePositive(ask) ||
      ask < bid
    ) {
      return;
    }

    const mid = (bid + ask) / 2;

    if (!isFinitePositive(mid)) {
      return;
    }

    const samples =
      this.priceHistory.get(key) ?? [];

    samples.push({
      timestamp,
      mid
    });

    const cutoff =
      timestamp -
      PRICE_HISTORY_TTL_MS;

    while (
      samples.length &&
      samples[0].timestamp < cutoff
    ) {
      samples.shift();
    }

    this.priceHistory.set(key, samples);
  }

  private getMomentumPct(
    key: string,
    now: number
  ): number | null {
    const samples =
      this.priceHistory.get(key);

    if (
      !samples ||
      samples.length < 2
    ) {
      return null;
    }

    const target =
      now -
      ENTRY_MOMENTUM_WINDOW_MS;

    const reference =
      samples
        .filter(
          sample =>
            now - sample.timestamp >=
            ENTRY_MOMENTUM_MIN_SAMPLE_AGE_MS
        )
        .sort(
          (a, b) =>
            Math.abs(a.timestamp - target) -
            Math.abs(b.timestamp - target)
        )[0];

    const latest =
      samples.at(-1);

    if (
      !reference ||
      !latest ||
      !isFinitePositive(reference.mid) ||
      !isFinitePositive(latest.mid)
    ) {
      return null;
    }

    return (
      (latest.mid - reference.mid) /
      reference.mid
    ) * 100;
  }

  private isMomentumAgainstPosition(
    direction: Direction,
    momentum: number
  ) {
    return direction === "LONG"
      ? momentum <=
        -LONG_ENTRY_MOMENTUM_BLOCK_PCT
      : momentum >=
        SHORT_ENTRY_MOMENTUM_BLOCK_PCT;
  }

  private estimateExecutableDexPrice(
    anchor: AnchorStatus,
    qtyUsd: number,
    direction: Direction
  ) {
    void qtyUsd;
    void direction;

    return isFinitePositive(anchor.dexPrice)
      ? anchor.dexPrice
      : NaN;
  }

  private calculateStopPrice(
    entry: number,
    direction: Direction,
    distance: number
  ) {
    return entry * (
      direction === "LONG"
        ? 1 - distance / 100
        : 1 + distance / 100
    );
  }

  private updateTwoPhaseStop(
    trade: PaperTrade,
    holdMs: number
  ) {
    if (trade.trailActive) {
      return;
    }

    const distance =
      this.getStopDistancePct(holdMs);

    const price =
      this.calculateStopPrice(
        trade.entryPrice,
        trade.direction,
        distance
      );

    if (!isFinitePositive(price)) {
      return;
    }

    trade.stopPrice =
      round(price);

    trade.stopDistancePct =
      round(distance, 4);
  }

  private isStopTriggered(
    trade: PaperTrade,
    bid: number,
    ask: number
  ) {
    if (!isFinitePositive(trade.stopPrice)) {
      return false;
    }

    return trade.direction === "LONG"
      ? bid <= trade.stopPrice
      : ask >= trade.stopPrice;
  }

  private getStopExecutionPrice(
    trade: PaperTrade
  ) {
    if (!isFinitePositive(trade.stopPrice)) {
      throw new Error(
        `Invalid stop price for trade ${trade.id}`
      );
    }

    const slippage =
      this.getStopSlippagePct() / 100;

    return trade.direction === "LONG"
      ? trade.stopPrice * (1 - slippage)
      : trade.stopPrice * (1 + slippage);
  }

  private calculateGrossPnlPct(
    trade: PaperTrade,
    exit: number
  ) {
    return trade.direction === "LONG"
      ? (
          (exit - trade.entryPrice) /
          trade.entryPrice
        ) * 100
      : (
          (trade.entryPrice - exit) /
          trade.entryPrice
        ) * 100;
  }

  private isAnchorBroken(
    trade: PaperTrade,
    price: number
  ) {
    if (
      !isFinitePositive(
        trade.dexAnchorAtEntry
      ) ||
      !isFinitePositive(price)
    ) {
      return false;
    }

    const move =
      (
        (price - trade.dexAnchorAtEntry) /
        trade.dexAnchorAtEntry
      ) * 100;

    return trade.direction === "LONG"
      ? move <=
        -ANCHOR_BREAK_DISTANCE_PCT
      : move >=
        ANCHOR_BREAK_DISTANCE_PCT;
  }

  private updateTrailingStop(
    trade: PaperTrade,
    bid: number,
    ask: number
  ) {
    const trigger =
      this.getTrailingTriggerPct();

    const distance =
      this.getTrailingDistancePct();

    if (
      trigger <= 0 ||
      distance <= 0
    ) {
      return;
    }

    const current =
      trade.direction === "LONG"
        ? bid
        : ask;

    if (!isFinitePositive(current)) {
      return;
    }

    const move =
      trade.direction === "LONG"
        ? (
            (current - trade.entryPrice) /
            trade.entryPrice
          ) * 100
        : (
            (trade.entryPrice - current) /
            trade.entryPrice
          ) * 100;

    const best =
      trade.trailBestPrice ?? current;

    const previous =
      trade.stopPrice;

    const stop =
      trade.direction === "LONG"
        ? current * (1 - distance / 100)
        : current * (1 + distance / 100);

    const improves =
      trade.direction === "LONG"
        ? stop > (previous ?? -Infinity)
        : stop < (previous ?? Infinity);

    if (!trade.trailActive) {
      if (move < trigger) {
        return;
      }

      trade.trailActive = true;
      trade.trailBestPrice = current;

      if (
        !isFinitePositive(previous) ||
        improves
      ) {
        trade.stopPrice =
          round(stop);
      }

      logger.debug(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          direction: trade.direction,
          movePct: round(move, 4),
          triggerPct: trigger,
          distancePct: distance,
          previousStopPrice: previous,
          newStopPrice: trade.stopPrice
        },
        "Trailing stop activated"
      );

      return;
    }

    const improvesBest =
      trade.direction === "LONG"
        ? current > best
        : current < best;

    if (!improvesBest) {
      return;
    }

    trade.trailBestPrice =
      current;

    if (
      !isFinitePositive(previous) ||
      improves
    ) {
      trade.stopPrice =
        round(stop);
    }
  }

  private updateAnchorReversal(
    risk: SymbolRiskState,
    direction: Direction,
    movePct: number
  ) {
    const favorable =
      direction === "LONG"
        ? movePct > 0
        : movePct < 0;

    const improving =
      risk.lastAnchorMovePct === undefined ||
      (
        direction === "LONG"
          ? movePct > risk.lastAnchorMovePct
          : movePct < risk.lastAnchorMovePct
      );

    if (favorable && improving) {
      risk.reversalConfirmations += 1;
    } else if (!favorable) {
      risk.reversalConfirmations = 0;
    }

    risk.lastAnchorMovePct =
      movePct;
  }

  private getPostCloseCooldownMs(
    reason: CloseReason,
    netPnlPct: number
  ) {
    if (
      reason === "anchor_loss" ||
      reason === "anchor_broken" ||
      reason === "stop_loss"
    ) {
      return LOSS_COOLDOWN_MS;
    }

    if (reason === "timeout") {
      return TIMEOUT_COOLDOWN_MS;
    }

    if (
      reason === "trailing_stop" ||
      reason === "mean_reverted_profit"
    ) {
      return netPnlPct >= 0.3
        ? PROFIT_COOLDOWN_MS
        : SMALL_PROFIT_COOLDOWN_MS;
    }

    return 0;
  }

  onSignal(
    signal: FlipSignal
  ): PaperAction | null {
    const key =
      normalizeSymbol(signal.symbol);

    const now =
      Date.now();

    const risk =
      this.getSymbolRiskState(key);

    if (now < risk.bannedUntil) {
      return this.skipSignal(
        signal,
        "symbol temporarily banned",
        {
          bannedUntil:
            new Date(
              risk.bannedUntil
            ).toISOString(),
          consecutiveStops:
            risk.consecutiveStops
        }
      );
    }

    if (now < risk.cooldownUntil) {
      return this.skipSignal(
        signal,
        "symbol cooldown active",
        {
          cooldownUntil:
            new Date(
              risk.cooldownUntil
            ).toISOString(),
          anchorLosses:
            risk.anchorLosses,
          consecutiveStops:
            risk.consecutiveStops
        }
      );
    }

    if (
      risk.anchorLosses >=
        MAX_CONSECUTIVE_STOPS &&
      risk.reversalConfirmations <
        ANCHOR_REVERSAL_CONFIRMATIONS
    ) {
      return this.skipSignal(
        signal,
        "blocked after consecutive anchor losses",
        {
          anchorLosses:
            risk.anchorLosses,
          reversalConfirmations:
            risk.reversalConfirmations,
          requiredConfirmations:
            ANCHOR_REVERSAL_CONFIRMATIONS
        }
      );
    }

    if (
      signal.spreadPct >
      MAX_ENTRY_SPREAD_PCT
    ) {
      return this.skipSignal(
        signal,
        "entry spread exceeds limit",
        {
          maxEntrySpreadPct:
            MAX_ENTRY_SPREAD_PCT
        }
      );
    }

    if (this.openTrades.has(key)) {
      return this.skipSignal(
        signal,
        "position already open"
      );
    }

    if (
      this.openTrades.size >=
      this.maxOpenTrades
    ) {
      return this.skipSignal(
        signal,
        "maximum open trades reached",
        {
          openTrades:
            this.openTrades.size,
          maxOpenTrades:
            this.maxOpenTrades
        }
      );
    }

    if (!isFinitePositive(this.depositUsd)) {
      return this.skipSignal(
        signal,
        "invalid deposit",
        {
          depositUsd:
            this.depositUsd
        }
      );
    }

    const bid =
      Number(signal.mexcBid);

    const ask =
      Number(signal.mexcAsk);

    if (
      !isFinitePositive(bid) ||
      !isFinitePositive(ask) ||
      ask < bid
    ) {
      return this.skipSignal(
        signal,
        "invalid MEXC order book",
        {
          bid,
          ask
        }
      );
    }

    if (
      signal.mexcBookSpreadPct >
      MAX_ENTRY_MEXC_BOOK_SPREAD_PCT
    ) {
      return this.skipSignal(
        signal,
        "MEXC book spread exceeds limit",
        {
          mexcBookSpreadPct:
            signal.mexcBookSpreadPct,
          maxEntryMexcBookSpreadPct:
            MAX_ENTRY_MEXC_BOOK_SPREAD_PCT
        }
      );
    }

    const historySamples =
      this.priceHistory.get(key)?.length ?? 0;

    const momentum =
      this.getMomentumPct(key, now);

    if (momentum === null) {
      return this.skipSignal(
        signal,
        "insufficient MEXC price history",
        {
          historySamples,
          requiredWindowMs:
            ENTRY_MOMENTUM_WINDOW_MS,
          minSampleAgeMs:
            ENTRY_MOMENTUM_MIN_SAMPLE_AGE_MS
        }
      );
    }

    if (
      this.isMomentumAgainstPosition(
        signal.direction,
        momentum
      )
    ) {
      return this.skipSignal(
        signal,
        "MEXC momentum is against position",
        {
          entryMomentumPct:
            round(momentum, 4),
          blockPct:
            signal.direction === "LONG"
              ? LONG_ENTRY_MOMENTUM_BLOCK_PCT
              : SHORT_ENTRY_MOMENTUM_BLOCK_PCT
        }
      );
    }

    const dexAgainst =
      signal.direction === "LONG"
        ? signal.dexDirectionalDriftPct < 0 ||
          (signal.dexTrendSlopePct ?? 0) < 0
        : signal.dexDirectionalDriftPct > 0 ||
          (signal.dexTrendSlopePct ?? 0) > 0;

    if (dexAgainst) {
      return this.skipSignal(
        signal,
        "DEX momentum is against position",
        {
          dexDirectionalDriftPct:
            signal.dexDirectionalDriftPct,
          dexTrendSlopePct:
            signal.dexTrendSlopePct ?? 0
        }
      );
    }

    const entry =
      signal.direction === "LONG"
        ? ask
        : bid;

    const deposit =
      this.depositUsd;

    const qtyUsd =
      deposit *
      this.tradeAllocationPct;

    if (!isFinitePositive(entry)) {
      return this.skipSignal(
        signal,
        "invalid paper entry price",
        {
          entryPrice: entry
        }
      );
    }

    const usedCapital =
      this.getUsedCapitalUsd();

    const maxExposure =
      this.getMaxTotalExposureUsd();

    if (
      usedCapital + qtyUsd >
      maxExposure
    ) {
      return this.skipSignal(
        signal,
        "maximum total exposure reached",
        {
          qtyUsd,
          usedCapitalUsd:
            usedCapital,
          maxExposureUsd:
            maxExposure
        }
      );
    }

    const qtyToken =
      qtyUsd / entry;

    if (
      !isFinitePositive(qtyUsd) ||
      !isFinitePositive(qtyToken)
    ) {
      return this.skipSignal(
        signal,
        "invalid paper position size",
        {
          qtyUsd,
          qtyToken
        }
      );
    }

    const anchor: AnchorStatus = {
      symbol: signal.symbol,
      dexPrice: signal.dexPrice,
      dexLiquidityUsd:
        signal.dexLiquidityUsd,
      dexVolumeM5:
        signal.dexVolumeM5,
      dexBuysM5:
        signal.dexBuysM5,
      dexSellsM5:
        signal.dexSellsM5,
      dexId: signal.dexId,
      chainId: signal.chainId,
      quoteSymbol: signal.quoteSymbol,
      dexPairAddress:
        signal.dexPairAddress,
      anchorAgeMs:
        signal.anchorAgeMs,
      dexUpdatedAt:
        signal.dexUpdatedAt,
      dexDriftPct:
        signal.dexDriftPct,
      dexDirectionalDriftPct:
        signal.dexDirectionalDriftPct,
      dexTrendSlopePct:
        signal.dexTrendSlopePct ?? 0,
      mexcBid: bid,
      mexcAsk: ask,
      mexcLast:
        signal.mexcPrice,
      mexcTurnover24h:
        signal.mexcTurnover24h,
      mexcBookSpreadPct:
        signal.mexcBookSpreadPct,
      longSpreadPct:
        signal.spreadPct,
      shortSpreadPct:
        signal.spreadPct
    };

    const dexPrice =
      this.estimateExecutableDexPrice(
        anchor,
        qtyUsd,
        signal.direction
      );

    if (!isFinitePositive(dexPrice)) {
      return this.skipSignal(
        signal,
        "invalid executable DEX price",
        {
          executableDexPrice:
            dexPrice
        }
      );
    }

    const stopDistance =
      this.getStopDistancePct();

    const stopPrice =
      this.calculateStopPrice(
        entry,
        signal.direction,
        stopDistance
      );

    const mid =
      (bid + ask) / 2;

    const fresh =
      Number.isFinite(signal.anchorAgeMs) &&
      signal.anchorAgeMs <=
        config.maxDexAnchorAgeMs;

    const diagnostics: EntryDiagnostics = {
      entryCheckedAt:
        now,
      entryAnchorAgeMs:
        signal.anchorAgeMs,
      entryAnchorIsFresh:
        fresh,
      entryDexUpdatedAt:
        signal.dexUpdatedAt,
      entryDexPrice:
        signal.dexPrice,
      entryMexcBid:
        bid,
      entryMexcAsk:
        ask,
      entryMexcMid:
        mid,
      entryMexcBookSpreadPct:
        signal.mexcBookSpreadPct,
      entrySpreadPct:
        signal.spreadPct,
      entryNetEdgePct:
        signal.netEdgePct,
      entryDexDriftPct:
        signal.dexDriftPct,
      entryDexDirectionalDriftPct:
        signal.dexDirectionalDriftPct,
      entryDexTrendSlopePct:
        signal.dexTrendSlopePct ?? 0,
      entryMomentumPct:
        momentum,
      entryMomentumBlocked:
        false,
      entryMomentumWindowMs:
        ENTRY_MOMENTUM_WINDOW_MS,
      maxEntrySpreadPct:
        MAX_ENTRY_SPREAD_PCT,
      maxEntryMexcBookSpreadPct:
        MAX_ENTRY_MEXC_BOOK_SPREAD_PCT,
      maxEntryAnchorAgeMs:
        config.maxDexAnchorAgeMs,
      anchorBreakDistancePct:
        ANCHOR_BREAK_DISTANCE_PCT,
      maxAnchorBreakLossPct:
        MAX_ANCHOR_BREAK_LOSS_PCT,
      anchorLossMinHoldMs:
        ANCHOR_LOSS_MIN_HOLD_MS,
      initialStopDistancePct:
        stopDistance,
      initialStopPrice:
        stopPrice
    };

    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      symbol: signal.symbol,
      direction: signal.direction,
      status: "OPEN",
      openedAt:
        new Date(now).toISOString(),
      entryPrice:
        round(entry),
      entryRef:
        signal.direction === "LONG"
          ? "ASK"
          : "BID",
      entryMexcBid:
        bid,
      entryMexcAsk:
        ask,
      entryMexcBookSpreadPct:
        signal.mexcBookSpreadPct,
      qtyUsd:
        round(qtyUsd, 2),
      qtyToken:
        round(qtyToken, 8),
      depositAtEntry:
        round(deposit, 4),
      allocationPct:
        this.tradeAllocationPct,
      dexAnchorAtEntry:
        round(dexPrice),
      dexSnapshotAtEntry:
        signal.dexUpdatedAt,
      entryAnchorAgeMs:
        signal.anchorAgeMs,
      entryAnchorIsFresh:
        fresh,
      entryMomentumPct:
        momentum,
      entryMomentumBlocked:
        false,
      entryMexcMid:
        mid,
      entryNetEdgePct:
        signal.netEdgePct,
      entryDexDriftPct:
        signal.dexDriftPct,
      entryDexDirectionalDriftPct:
        signal.dexDirectionalDriftPct,
      entryDexTrendSlopePct:
        signal.dexTrendSlopePct ?? 0,
      maxEntryMexcBookSpreadPct:
        MAX_ENTRY_MEXC_BOOK_SPREAD_PCT,
      maxAnchorBreakLossPct:
        MAX_ANCHOR_BREAK_LOSS_PCT,
      entrySpreadPct:
        round(signal.spreadPct, 4),
      stopPrice:
        round(stopPrice),
      stopDistancePct:
        round(stopDistance, 4),
      trailActive:
        false,
      trailBestPrice:
        round(entry),
      trailTriggerPct:
        this.getTrailingTriggerPct(),
      trailDistancePct:
        this.getTrailingDistancePct(),
      openReason:
        signal.reason
    };

    this.entryDiagnostics.set(
      key,
      diagnostics
    );

    this.openTrades.set(
      key,
      trade
    );

    this.liquidityAtEntry.set(
      key,
      Number(signal.dexLiquidityUsd)
    );

    logger.warn(
      {
        id: trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        entrySpreadPct:
          trade.entrySpreadPct,
        entryMomentumPct:
          trade.entryMomentumPct,
        dexAnchorAtEntry:
          trade.dexAnchorAtEntry,
        stopPrice:
          trade.stopPrice,
        qtyUsd:
          trade.qtyUsd,
        depositAtEntry:
          trade.depositAtEntry,
        minNetProfitPct:
          MIN_NET_PROFIT_PCT
      },
      "PAPER TRADE OPENED"
    );

    return {
      action: "OPEN",
      trade
    };
  }

  onTicker(
    ticker: MexcTicker,
    anchor: AnchorStatus | null
  ): PaperAction | null {
    const key =
      normalizeSymbol(ticker.symbol);

    const trade =
      this.openTrades.get(key);

    if (
      !trade ||
      this.processedCloseTrades.has(
        trade.id
      )
    ) {
      return null;
    }

    const now =
      Date.now();

    const holdMs =
      Math.max(
        0,
        now -
          new Date(
            trade.openedAt
          ).getTime()
      );

    const previousStopPrice =
      trade.stopPrice;

    const previousStopDistancePct =
      trade.stopDistancePct;

    this.updateTwoPhaseStop(
      trade,
      holdMs
    );

    const exitBid =
      Number(ticker.bid1);

    const exitAsk =
      Number(ticker.ask1);

    if (
      !isFinitePositive(exitBid) ||
      !isFinitePositive(exitAsk) ||
      exitAsk < exitBid
    ) {
      return null;
    }

    const exitMid =
      (exitBid + exitAsk) / 2;

    const exitBookSpreadPct =
      isFinitePositive(exitMid)
        ? (
            (exitAsk - exitBid) /
            exitMid
          ) * 100
        : undefined;

    const marketExitPrice =
      trade.direction === "LONG"
        ? exitBid
        : exitAsk;

    const marketGrossPnlPct =
      this.calculateGrossPnlPct(
        trade,
        marketExitPrice
      );

    const marketNetPnlPct =
      marketGrossPnlPct -
      this.getTotalCostsPct();

    const anchorLossTriggered =
      holdMs >=
        ANCHOR_LOSS_MIN_HOLD_MS &&
      marketNetPnlPct <=
        -MAX_ANCHOR_BREAK_LOSS_PCT;

    this.updateTrailingStop(
      trade,
      exitBid,
      exitAsk
    );

    const stopTriggered =
      this.isStopTriggered(
        trade,
        exitBid,
        exitAsk
      );

    const anchorIsFresh =
      anchor !== null &&
      Number.isFinite(
        anchor.anchorAgeMs
      ) &&
      anchor.anchorAgeMs <=
        config.maxDexAnchorAgeMs;

    let currentDexPrice:
      | number
      | undefined;

    let currentSpreadPct:
      | number
      | undefined;

    let anchorBroken =
      false;

    let dexMoveFromEntryPct:
      | number
      | undefined;

    if (
      anchor &&
      anchorIsFresh
    ) {
      const freshDexPrice =
        this.estimateExecutableDexPrice(
          anchor,
          trade.qtyUsd,
          trade.direction
        );

      if (
        isFinitePositive(
          freshDexPrice
        )
      ) {
        currentDexPrice =
          freshDexPrice;

        currentSpreadPct =
          trade.direction === "LONG"
            ? (
                (freshDexPrice - exitAsk) /
                exitAsk
              ) * 100
            : (
                (exitBid - freshDexPrice) /
                exitBid
              ) * 100;

        if (
          isFinitePositive(
            trade.dexAnchorAtEntry
          )
        ) {
          dexMoveFromEntryPct =
            (
              (
                freshDexPrice -
                trade.dexAnchorAtEntry
              ) /
              trade.dexAnchorAtEntry
            ) * 100;

          anchorBroken =
            this.isAnchorBroken(
              trade,
              freshDexPrice
            );

          this.updateAnchorReversal(
            this.getSymbolRiskState(key),
            trade.direction,
            dexMoveFromEntryPct
          );
        }
      }
    }

    const spreadExitReached =
      currentSpreadPct !== undefined &&
      currentSpreadPct <=
        config.paperExitSpreadPct;

    const minHoldReached =
      holdMs >=
      this.getMinHoldMs();

    let closeReason:
      | CloseReason
      | null = null;

    let exitPrice =
      marketExitPrice;

    let stopTriggerPrice:
      | number
      | undefined;

    if (anchorBroken) {
      closeReason =
        "anchor_broken";
    } else if (anchorLossTriggered) {
      closeReason =
        "anchor_loss";
    } else if (stopTriggered) {
      closeReason =
        trade.trailActive
          ? "trailing_stop"
          : "stop_loss";

      stopTriggerPrice =
        trade.direction === "LONG"
          ? exitBid
          : exitAsk;

      exitPrice =
        this.getStopExecutionPrice(
          trade
        );
    } else if (
      minHoldReached &&
      spreadExitReached &&
      marketNetPnlPct >=
        MIN_NET_PROFIT_PCT &&
      currentSpreadPct !== undefined &&
      currentSpreadPct <=
        MAX_EXIT_SPREAD_PCT
    ) {
      closeReason =
        "mean_reverted_profit";
    } else if (
      minHoldReached &&
      holdMs >=
        config.paperMaxHoldMs
    ) {
      closeReason =
        "timeout";
    }

    if (!closeReason) {
      return null;
    }

    this.processedCloseTrades.add(
      trade.id
    );

    const grossPnlPct =
      this.calculateGrossPnlPct(
        trade,
        exitPrice
      );

    const totalCostsPct =
      this.getTotalCostsPct();

    const netPnlPct =
      grossPnlPct -
      totalCostsPct;

    const grossPnlUsd =
      trade.qtyUsd *
      grossPnlPct /
      100;

    const netPnlUsd =
      trade.qtyUsd *
      netPnlPct /
      100;

    if (
      ![
        grossPnlPct,
        netPnlPct,
        grossPnlUsd,
        netPnlUsd
      ].every(Number.isFinite)
    ) {
      this.processedCloseTrades.delete(
        trade.id
      );

      return null;
    }

    const riskState =
      this.getSymbolRiskState(
        key
      );

    if (
      closeReason === "stop_loss"
    ) {
      riskState.consecutiveStops += 1;

      if (
        riskState.consecutiveStops >=
        MAX_CONSECUTIVE_STOPS
      ) {
        riskState.bannedUntil =
          now +
          SYMBOL_BAN_DURATION_MS;
      }
    }

    if (
      closeReason === "anchor_loss"
    ) {
      riskState.anchorLosses += 1;
    } else if (
      closeReason === "mean_reverted_profit" ||
      closeReason === "trailing_stop"
    ) {
      riskState.consecutiveStops = 0;
      riskState.anchorLosses = 0;
      riskState.reversalConfirmations = 0;
    }

    const cooldownMs =
      this.getPostCloseCooldownMs(
        closeReason,
        netPnlPct
      );

    if (cooldownMs > 0) {
      riskState.cooldownUntil =
        now + cooldownMs;
    }

    const depositBeforeClose =
      this.depositUsd;

    const depositAfterClose =
      Math.max(
        0,
        round(
          depositBeforeClose +
          netPnlUsd,
          4
        )
      );

    const closedTrade: PaperTrade = {
      ...trade,
      status: "CLOSED",
      closedAt:
        new Date(now).toISOString(),
      exitPrice:
        round(exitPrice),
      exitRef:
        trade.direction === "LONG"
          ? "BID"
          : "ASK",
      exitMexcBid:
        exitBid,
      exitMexcAsk:
        exitAsk,
      exitMexcBookSpreadPct:
        exitBookSpreadPct,
      dexAnchorAtExit:
        anchorIsFresh &&
        currentDexPrice !== undefined
          ? currentDexPrice
          : trade.dexAnchorAtEntry,
      dexSnapshotAtExit:
        anchorIsFresh
          ? anchor?.dexUpdatedAt
          : undefined,
      exitSpreadPct:
        currentSpreadPct !== undefined
          ? round(
              currentSpreadPct,
              4
            )
          : undefined,
      marketExitPrice:
        round(marketExitPrice),
      marketGrossPnlPct:
        round(
          marketGrossPnlPct,
          4
        ),
      marketNetPnlPct:
        round(
          marketNetPnlPct,
          4
        ),
      anchorAgeMsAtExit:
        anchor?.anchorAgeMs,
      anchorIsFreshAtExit:
        anchorIsFresh,
      dexMoveFromEntryPct:
        dexMoveFromEntryPct !== undefined
          ? round(
              dexMoveFromEntryPct,
              4
            )
          : undefined,
      anchorBroken,
      anchorLossTriggered,
      stopPriceAtExit:
        trade.stopPrice,
      stopDistancePctAtExit:
        trade.stopDistancePct,
      grossPnlPct:
        round(
          grossPnlPct,
          4
        ),
      netPnlPct:
        round(
          netPnlPct,
          4
        ),
      grossPnlUsd:
        round(
          grossPnlUsd,
          4
        ),
      netPnlUsd:
        round(
          netPnlUsd,
          4
        ),
      depositAfterClose,
      holdMs,
      closeReason,
      stopTriggerPrice:
        stopTriggerPrice !== undefined
          ? round(
              stopTriggerPrice
            )
          : undefined,
      stopSlippagePct:
        closeReason === "stop_loss" ||
        closeReason === "trailing_stop"
          ? this.getStopSlippagePct()
          : undefined
    };

    this.depositUsd =
      depositAfterClose;

    this.openTrades.delete(
      key
    );

    this.liquidityAtEntry.delete(
      key
    );

    this.entryDiagnostics.delete(
      key
    );

    logger.warn(
      {
        tradeId:
          closedTrade.id,
        symbol:
          closedTrade.symbol,
        direction:
          closedTrade.direction,
        closeReason,
        holdMs,
        previousStopPrice,
        previousStopDistancePct,
        cooldownMs,
        pnl: {
          grossPnlPct:
            closedTrade.grossPnlPct,
          netPnlPct:
            closedTrade.netPnlPct,
          grossPnlUsd:
            closedTrade.grossPnlUsd,
          netPnlUsd:
            closedTrade.netPnlUsd,
          totalCostsPct
        },
        risk: {
          consecutiveStops:
            riskState.consecutiveStops,
          anchorLosses:
            riskState.anchorLosses,
          cooldownUntil:
            riskState.cooldownUntil > now
              ? new Date(
                  riskState.cooldownUntil
                ).toISOString()
              : undefined,
          bannedUntil:
            riskState.bannedUntil > now
              ? new Date(
                  riskState.bannedUntil
                ).toISOString()
              : undefined
        },
        depositBeforeClose,
        depositAfterClose,
        configuration: {
          maxEntrySpreadPct:
            MAX_ENTRY_SPREAD_PCT,
          maxEntryMexcBookSpreadPct:
            MAX_ENTRY_MEXC_BOOK_SPREAD_PCT,
          maxExitSpreadPct:
            MAX_EXIT_SPREAD_PCT,
          lossCooldownMs:
            LOSS_COOLDOWN_MS,
          smallProfitCooldownMs:
            SMALL_PROFIT_COOLDOWN_MS,
          profitCooldownMs:
            PROFIT_COOLDOWN_MS,
          timeoutCooldownMs:
            TIMEOUT_COOLDOWN_MS,
          maxDexAnchorAgeMs:
            config.maxDexAnchorAgeMs,
          anchorBreakDistancePct:
            ANCHOR_BREAK_DISTANCE_PCT,
          maxAnchorBreakLossPct:
            MAX_ANCHOR_BREAK_LOSS_PCT,
          anchorLossMinHoldMs:
            ANCHOR_LOSS_MIN_HOLD_MS,
          initialStopDurationMs:
            INITIAL_STOP_DURATION_MS,
          initialStopDistancePct:
            INITIAL_STOP_DISTANCE_PCT,
          regularStopDistancePct:
            REGULAR_STOP_DISTANCE_PCT,
          entryMomentumWindowMs:
            ENTRY_MOMENTUM_WINDOW_MS,
          longEntryMomentumBlockPct:
            LONG_ENTRY_MOMENTUM_BLOCK_PCT,
          shortEntryMomentumBlockPct:
            SHORT_ENTRY_MOMENTUM_BLOCK_PCT,
          minNetProfitPct:
            MIN_NET_PROFIT_PCT
        }
      },
      "PAPER TRADE CLOSED"
    );

    return {
      action: "CLOSE",
      trade: closedTrade
    };
  }
}
