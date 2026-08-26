import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { CloseReason, FlipSignal, MexcTicker, PaperTrade } from "../types.js";
import type { AnchorStatus } from "./spread-engine.js";

type PaperAction = { action: "OPEN" | "CLOSE"; trade: PaperTrade };
type Direction = "LONG" | "SHORT";

const MAX_ENTRY_SPREAD_PCT = 4.5;
const MIN_NET_PROFIT_PCT = 0.1;
const SYMBOL_STOP_COOLDOWN_MS = 15 * 60 * 1000;
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

interface SymbolRiskState { consecutiveStops: number; cooldownUntil: number; bannedUntil: number }
interface PriceSample { timestamp: number; mid: number }
interface EntryDiagnostics {
  entryCheckedAt: number; entryAnchorAgeMs: number; entryAnchorIsFresh: boolean; entryDexUpdatedAt: number;
  entryDexPrice: number; entryMexcBid: number; entryMexcAsk: number; entryMexcMid: number;
  entryMexcBookSpreadPct: number; entrySpreadPct: number; entryNetEdgePct: number; entryDexDriftPct: number;
  entryDexDirectionalDriftPct: number; entryDexTrendSlopePct: number; entryMomentumPct: number;
  entryMomentumBlocked: boolean; entryMomentumWindowMs: number; maxEntrySpreadPct: number;
  maxEntryMexcBookSpreadPct: number; maxEntryAnchorAgeMs: number; anchorBreakDistancePct: number;
  maxAnchorBreakLossPct: number; anchorLossMinHoldMs: number; initialStopDistancePct: number; initialStopPrice: number;
}

const normalizeSymbol = (v: string) => String(v).trim().toUpperCase().replace(/[_\-/\s]/g, "");
const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;
const isFinitePositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export class PaperExecutionService {
  private readonly openTrades = new Map<string, PaperTrade>();
  private readonly processedCloseTrades = new Set<string>();
  private readonly liquidityAtEntry = new Map<string, number>();
  private readonly symbolRisk = new Map<string, SymbolRiskState>();
  private readonly priceHistory = new Map<string, PriceSample[]>();
  private readonly entryDiagnostics = new Map<string, EntryDiagnostics>();
  private readonly maxOpenTrades = 3;
  private readonly tradeAllocationPct = 0.3;
  private depositUsd = 100;

  getDepositUsd() { return round(this.depositUsd, 4); }
  getOpenTradesCount() { return this.openTrades.size; }

  recordTicker(ticker: MexcTicker) {
    const key = normalizeSymbol(ticker.symbol);
    this.recordPriceSample(key, Number(ticker.bid1), Number(ticker.ask1), Date.now());
  }

  private getTotalCostsPct() { return config.roundTripCostPct; }
  private getUsedCapitalUsd() { return [...this.openTrades.values()].reduce((sum, t) => sum + t.qtyUsd, 0); }
  private getMaxTotalExposureUsd() { return this.depositUsd * config.paperMaxTotalExposurePct; }
  private getStopDistancePct(holdMs = 0) { return holdMs < INITIAL_STOP_DURATION_MS ? INITIAL_STOP_DISTANCE_PCT : REGULAR_STOP_DISTANCE_PCT; }
  private getStopSlippagePct() { return config.paperStopSlippagePct; }
  private getMinHoldMs() { return config.paperMinHoldMs; }
  private getTrailingTriggerPct() { return config.paperTrailingTriggerPct; }
  private getTrailingDistancePct() { return config.paperTrailingDistancePct; }

  private getSymbolRiskState(key: string) {
    let state = this.symbolRisk.get(key);
    if (!state) this.symbolRisk.set(key, state = { consecutiveStops: 0, cooldownUntil: 0, bannedUntil: 0 });
    return state;
  }

  private recordPriceSample(key: string, bid: number, ask: number, timestamp: number) {
    if (!isFinitePositive(bid) || !isFinitePositive(ask) || ask < bid) return;
    const mid = (bid + ask) / 2;
    if (!isFinitePositive(mid)) return;
    const samples = this.priceHistory.get(key) ?? [];
    samples.push({ timestamp, mid });
    const cutoff = timestamp - PRICE_HISTORY_TTL_MS;
    while (samples.length && samples[0].timestamp < cutoff) samples.shift();
    this.priceHistory.set(key, samples);
  }

  private getMomentumPct(key: string, now: number): number | null {
    const samples = this.priceHistory.get(key);
    if (!samples || samples.length < 2) return null;
    const target = now - ENTRY_MOMENTUM_WINDOW_MS;
    const eligible = samples.filter(s => now - s.timestamp >= ENTRY_MOMENTUM_MIN_SAMPLE_AGE_MS);
    const reference = eligible.sort((a, b) => Math.abs(a.timestamp - target) - Math.abs(b.timestamp - target))[0];
    const latest = samples.at(-1);
    if (!reference || !latest || !isFinitePositive(reference.mid) || !isFinitePositive(latest.mid)) return null;
    return (latest.mid - reference.mid) / reference.mid * 100;
  }

  private isMomentumAgainstPosition(direction: Direction, momentum: number) {
    return direction === "LONG"
      ? momentum <= -LONG_ENTRY_MOMENTUM_BLOCK_PCT
      : momentum >= SHORT_ENTRY_MOMENTUM_BLOCK_PCT;
  }

  private estimateExecutableDexPrice(anchor: AnchorStatus, qtyUsd: number, direction: Direction) {
    void qtyUsd; void direction;
    return isFinitePositive(anchor.dexPrice) ? anchor.dexPrice : NaN;
  }

  private calculateStopPrice(entry: number, direction: Direction, distance: number) {
    return entry * (direction === "LONG" ? 1 - distance / 100 : 1 + distance / 100);
  }

  private updateTwoPhaseStop(trade: PaperTrade, holdMs: number) {
    if (trade.trailActive) return;
    const distance = this.getStopDistancePct(holdMs);
    const price = this.calculateStopPrice(trade.entryPrice, trade.direction, distance);
    if (!isFinitePositive(price)) return;
    trade.stopPrice = round(price);
    trade.stopDistancePct = round(distance, 4);
  }

  private isStopTriggered(trade: PaperTrade, bid: number, ask: number) {
    if (!isFinitePositive(trade.stopPrice)) return false;
    return trade.direction === "LONG" ? bid <= trade.stopPrice : ask >= trade.stopPrice;
  }

  private getStopExecutionPrice(trade: PaperTrade) {
    if (!isFinitePositive(trade.stopPrice)) throw new Error(`Invalid stop price for trade ${trade.id}`);
    const slippage = this.getStopSlippagePct() / 100;
    return trade.stopPrice * (trade.direction === "LONG" ? 1 - slippage : 1 + slippage);
  }

  private calculateGrossPnlPct(trade: PaperTrade, exit: number) {
    return trade.direction === "LONG"
      ? (exit - trade.entryPrice) / trade.entryPrice * 100
      : (trade.entryPrice - exit) / trade.entryPrice * 100;
  }

  private isAnchorBroken(trade: PaperTrade, price: number) {
    if (!isFinitePositive(trade.dexAnchorAtEntry) || !isFinitePositive(price)) return false;
    const move = (price - trade.dexAnchorAtEntry) / trade.dexAnchorAtEntry * 100;
    return trade.direction === "LONG" ? move <= -ANCHOR_BREAK_DISTANCE_PCT : move >= ANCHOR_BREAK_DISTANCE_PCT;
  }

  private updateTrailingStop(trade: PaperTrade, bid: number, ask: number) {
    const trigger = this.getTrailingTriggerPct(), distance = this.getTrailingDistancePct();
    if (trigger <= 0 || distance <= 0) return;
    const current = trade.direction === "LONG" ? bid : ask;
    if (!isFinitePositive(current)) return;
    const move = trade.direction === "LONG"
      ? (current - trade.entryPrice) / trade.entryPrice * 100
      : (trade.entryPrice - current) / trade.entryPrice * 100;
    const best = trade.trailBestPrice ?? current, previous = trade.stopPrice;
    const better = (price: number) => trade.direction === "LONG" ? price > (previous ?? -Infinity) : price < (previous ?? Infinity);
    const stop = trade.direction === "LONG" ? current * (1 - distance / 100) : current * (1 + distance / 100);

    if (!trade.trailActive) {
      if (move < trigger) return;
      trade.trailActive = true; trade.trailBestPrice = current;
      if (!isFinitePositive(previous) || better(stop)) trade.stopPrice = round(stop);
      logger.debug({ tradeId: trade.id, symbol: trade.symbol, direction: trade.direction, movePct: round(move, 4), triggerPct: trigger, distancePct: distance, previousStopPrice: previous, newStopPrice: trade.stopPrice }, "Trailing stop activated");
      return;
    }

    if ((trade.direction === "LONG" && current > best) || (trade.direction === "SHORT" && current < best)) {
      trade.trailBestPrice = current;
      if (!isFinitePositive(previous) || better(stop)) trade.stopPrice = round(stop);
    }
  }

  onSignal(signal: FlipSignal): PaperAction | null {
    const key = normalizeSymbol(signal.symbol), now = Date.now(), risk = this.getSymbolRiskState(key);
    if (now < risk.bannedUntil || now < risk.cooldownUntil || signal.spreadPct > MAX_ENTRY_SPREAD_PCT || this.openTrades.has(key) || this.openTrades.size >= this.maxOpenTrades || !isFinitePositive(this.depositUsd)) return null;

    const bid = Number(signal.mexcBid), ask = Number(signal.mexcAsk);
    if (!isFinitePositive(bid) || !isFinitePositive(ask) || ask < bid || signal.mexcBookSpreadPct > MAX_ENTRY_MEXC_BOOK_SPREAD_PCT) return null;
    const historySamples = this.priceHistory.get(key)?.length ?? 0, momentum = this.getMomentumPct(key, now);
    if (momentum === null || this.isMomentumAgainstPosition(signal.direction, momentum)) return null;

    const dexAgainst = signal.direction === "LONG"
      ? signal.dexDirectionalDriftPct < -0.1 || (signal.dexTrendSlopePct ?? 0) < -0.1
      : signal.dexDirectionalDriftPct > 0.1 || (signal.dexTrendSlopePct ?? 0) > 0.1;
    if (dexAgainst) return null;

    const entry = signal.direction === "LONG" ? ask : bid, deposit = this.depositUsd, qtyUsd = deposit * this.tradeAllocationPct;
    if (!isFinitePositive(entry) || this.getUsedCapitalUsd() + qtyUsd > this.getMaxTotalExposureUsd()) return null;
    const qtyToken = qtyUsd / entry;
    if (!isFinitePositive(qtyUsd) || !isFinitePositive(qtyToken)) return null;

    const anchor: AnchorStatus = {
      symbol: signal.symbol, dexPrice: signal.dexPrice, dexLiquidityUsd: signal.dexLiquidityUsd, dexVolumeM5: signal.dexVolumeM5,
      dexBuysM5: signal.dexBuysM5, dexSellsM5: signal.dexSellsM5, dexId: signal.dexId, chainId: signal.chainId,
      quoteSymbol: signal.quoteSymbol, dexPairAddress: signal.dexPairAddress, anchorAgeMs: signal.anchorAgeMs,
      dexUpdatedAt: signal.dexUpdatedAt, dexDriftPct: signal.dexDriftPct, dexDirectionalDriftPct: signal.dexDirectionalDriftPct,
      dexTrendSlopePct: signal.dexTrendSlopePct ?? 0, mexcBid: bid, mexcAsk: ask, mexcLast: signal.mexcPrice,
      mexcTurnover24h: signal.mexcTurnover24h, mexcBookSpreadPct: signal.mexcBookSpreadPct,
      longSpreadPct: signal.spreadPct, shortSpreadPct: signal.spreadPct
    };
    const dexPrice = this.estimateExecutableDexPrice(anchor, qtyUsd, signal.direction);
    if (!isFinitePositive(dexPrice)) return null;
    const stopDistance = this.getStopDistancePct(), stopPrice = this.calculateStopPrice(entry, signal.direction, stopDistance), mid = (bid + ask) / 2;
    const fresh = Number.isFinite(signal.anchorAgeMs) && signal.anchorAgeMs <= config.maxDexAnchorAgeMs;
    const diagnostics: EntryDiagnostics = {
      entryCheckedAt: now, entryAnchorAgeMs: signal.anchorAgeMs, entryAnchorIsFresh: fresh, entryDexUpdatedAt: signal.dexUpdatedAt,
      entryDexPrice: signal.dexPrice, entryMexcBid: bid, entryMexcAsk: ask, entryMexcMid: mid,
      entryMexcBookSpreadPct: signal.mexcBookSpreadPct, entrySpreadPct: signal.spreadPct, entryNetEdgePct: signal.netEdgePct,
      entryDexDriftPct: signal.dexDriftPct, entryDexDirectionalDriftPct: signal.dexDirectionalDriftPct,
      entryDexTrendSlopePct: signal.dexTrendSlopePct ?? 0, entryMomentumPct: momentum, entryMomentumBlocked: false,
      entryMomentumWindowMs: ENTRY_MOMENTUM_WINDOW_MS, maxEntrySpreadPct: MAX_ENTRY_SPREAD_PCT,
      maxEntryMexcBookSpreadPct: MAX_ENTRY_MEXC_BOOK_SPREAD_PCT, maxEntryAnchorAgeMs: config.maxDexAnchorAgeMs,
      anchorBreakDistancePct: ANCHOR_BREAK_DISTANCE_PCT, maxAnchorBreakLossPct: MAX_ANCHOR_BREAK_LOSS_PCT,
      anchorLossMinHoldMs: ANCHOR_LOSS_MIN_HOLD_MS, initialStopDistancePct: stopDistance, initialStopPrice: stopPrice
    };
    const trade: PaperTrade = {
      id: crypto.randomUUID(), symbol: signal.symbol, direction: signal.direction, status: "OPEN", openedAt: new Date(now).toISOString(),
      entryPrice: round(entry), entryRef: signal.direction === "LONG" ? "ASK" : "BID", entryMexcBid: bid, entryMexcAsk: ask,
      entryMexcBookSpreadPct: signal.mexcBookSpreadPct, qtyUsd: round(qtyUsd, 2), qtyToken: round(qtyToken, 8),
      depositAtEntry: round(deposit, 4), allocationPct: this.tradeAllocationPct, dexAnchorAtEntry: round(dexPrice),
      dexSnapshotAtEntry: signal.dexUpdatedAt, entryAnchorAgeMs: signal.anchorAgeMs, entryAnchorIsFresh: fresh,
      entryMomentumPct: momentum, entryMomentumBlocked: false, entryMexcMid: mid, entryNetEdgePct: signal.netEdgePct,
      entryDexDriftPct: signal.dexDriftPct, entryDexDirectionalDriftPct: signal.dexDirectionalDriftPct, entryDexTrendSlopePct: signal.dexTrendSlopePct ?? 0,
      maxEntryMexcBookSpreadPct: MAX_ENTRY_MEXC_BOOK_SPREAD_PCT, maxAnchorBreakLossPct: MAX_ANCHOR_BREAK_LOSS_PCT,
      entrySpreadPct: round(signal.spreadPct, 4), stopPrice: round(stopPrice), stopDistancePct: round(stopDistance, 4),
      trailActive: false, trailBestPrice: round(entry), trailTriggerPct: this.getTrailingTriggerPct(),
      trailDistancePct: this.getTrailingDistancePct(), openReason: signal.reason
    };
    this.entryDiagnostics.set(key, diagnostics); this.openTrades.set(key, trade); this.liquidityAtEntry.set(key, Number(signal.dexLiquidityUsd));
    logger.warn({ id: trade.id, symbol: trade.symbol, direction: trade.direction, entryPrice: trade.entryPrice, entrySpreadPct: trade.entrySpreadPct, entryMomentumPct: trade.entryMomentumPct, dexAnchorAtEntry: trade.dexAnchorAtEntry, stopPrice: trade.stopPrice, qtyUsd: trade.qtyUsd, depositAtEntry: trade.depositAtEntry, minNetProfitPct: MIN_NET_PROFIT_PCT }, "PAPER TRADE OPENED");
    return { action: "OPEN", trade };
  }

  onTicker(ticker: MexcTicker, anchor: AnchorStatus | null): PaperAction | null {
    const key = normalizeSymbol(ticker.symbol), trade = this.openTrades.get(key);
    if (!trade || this.processedCloseTrades.has(trade.id)) return null;
    const now = Date.now(), holdMs = Math.max(0, now - new Date(trade.openedAt).getTime());
    const previousStopPrice = trade.stopPrice, previousStopDistancePct = trade.stopDistancePct;
    this.updateTwoPhaseStop(trade, holdMs);
    const bid = Number(ticker.bid1), ask = Number(ticker.ask1);
    if (!isFinitePositive(bid) || !isFinitePositive(ask) || ask < bid) return null;
    const mid = (bid + ask) / 2, exitBookSpreadPct = isFinitePositive(mid) ? (ask - bid) / mid * 100 : undefined;
    const marketExit = trade.direction === "LONG" ? bid : ask, marketGross = this.calculateGrossPnlPct(trade, marketExit), marketNet = marketGross - this.getTotalCostsPct();
    const anchorLoss = holdMs >= ANCHOR_LOSS_MIN_HOLD_MS && marketNet <= -MAX_ANCHOR_BREAK_LOSS_PCT;
    this.updateTrailingStop(trade, bid, ask);
    const stopTriggered = this.isStopTriggered(trade, bid, ask), fresh = !!anchor && Number.isFinite(anchor.anchorAgeMs) && anchor.anchorAgeMs <= config.maxDexAnchorAgeMs;
    let currentDexPrice: number | undefined, currentSpreadPct: number | undefined, dexMove: number | undefined, anchorBroken = false;
    if (anchor && fresh) {
      const price = this.estimateExecutableDexPrice(anchor, trade.qtyUsd, trade.direction);
      if (isFinitePositive(price)) {
        currentDexPrice = price;
        currentSpreadPct = trade.direction === "LONG" ? (price - ask) / ask * 100 : (bid - price) / bid * 100;
        if (isFinitePositive(trade.dexAnchorAtEntry)) {
          dexMove = (price - trade.dexAnchorAtEntry) / trade.dexAnchorAtEntry * 100;
          anchorBroken = this.isAnchorBroken(trade, price);
        }
      }
    }
    const spreadExitReached = currentSpreadPct !== undefined && currentSpreadPct <= config.paperExitSpreadPct;
    const minHold = holdMs >= this.getMinHoldMs();
    let closeReason: CloseReason | null = null, exitPrice = marketExit, stopTriggerPrice: number | undefined;
    if (anchorBroken) closeReason = "anchor_broken";
    else if (anchorLoss) closeReason = "anchor_loss";
    else if (stopTriggered) { closeReason = trade.trailActive ? "trailing_stop" : "stop_loss"; stopTriggerPrice = trade.direction === "LONG" ? bid : ask; exitPrice = this.getStopExecutionPrice(trade); }
    else if (minHold && spreadExitReached && marketNet >= MIN_NET_PROFIT_PCT) closeReason = "mean_reverted_profit";
    else if (minHold && holdMs >= config.paperMaxHoldMs) closeReason = "timeout";
    if (!closeReason) return null;

    this.processedCloseTrades.add(trade.id);
    const gross = this.calculateGrossPnlPct(trade, exitPrice), costs = this.getTotalCostsPct(), net = gross - costs;
    const grossUsd = trade.qtyUsd * gross / 100, netUsd = trade.qtyUsd * net / 100;
    if (![gross, net, grossUsd, netUsd].every(Number.isFinite)) { this.processedCloseTrades.delete(trade.id); return null; }

    const risk = this.getSymbolRiskState(key);
    if (closeReason === "stop_loss") {
      risk.consecutiveStops++; risk.cooldownUntil = now + SYMBOL_STOP_COOLDOWN_MS;
      if (risk.consecutiveStops >= MAX_CONSECUTIVE_STOPS) risk.bannedUntil = now + SYMBOL_BAN_DURATION_MS;
    } else if (closeReason === "mean_reverted_profit" || closeReason === "trailing_stop") risk.consecutiveStops = 0;

    const depositBeforeClose = this.depositUsd, depositAfterClose = Math.max(0, round(depositBeforeClose + netUsd, 4));
    const closedTrade: PaperTrade = {
      ...trade, status: "CLOSED", closedAt: new Date(now).toISOString(), exitPrice: round(exitPrice), exitRef: trade.direction === "LONG" ? "BID" : "ASK",
      exitMexcBid: bid, exitMexcAsk: ask, exitMexcBookSpreadPct: exitBookSpreadPct,
      dexAnchorAtExit: fresh && currentDexPrice !== undefined ? currentDexPrice : trade.dexAnchorAtEntry,
      dexSnapshotAtExit: fresh ? anchor?.dexUpdatedAt : undefined, exitSpreadPct: currentSpreadPct === undefined ? undefined : round(currentSpreadPct, 4),
      marketExitPrice: round(marketExit), marketGrossPnlPct: round(marketGross, 4), marketNetPnlPct: round(marketNet, 4),
      anchorAgeMsAtExit: anchor?.anchorAgeMs, anchorIsFreshAtExit: fresh, dexMoveFromEntryPct: dexMove === undefined ? undefined : round(dexMove, 4),
      anchorBroken, anchorLossTriggered: anchorLoss, stopPriceAtExit: trade.stopPrice, stopDistancePctAtExit: trade.stopDistancePct,
      grossPnlPct: round(gross, 4), netPnlPct: round(net, 4), grossPnlUsd: round(grossUsd, 4), netPnlUsd: round(netUsd, 4),
      depositAfterClose, holdMs, closeReason, stopTriggerPrice: stopTriggerPrice === undefined ? undefined : round(stopTriggerPrice),
      stopSlippagePct: closeReason === "stop_loss" || closeReason === "trailing_stop" ? this.getStopSlippagePct() : undefined
    };
    this.depositUsd = depositAfterClose; this.openTrades.delete(key); this.liquidityAtEntry.delete(key); this.entryDiagnostics.delete(key);
    logger.warn({ tradeId: closedTrade.id, symbol: closedTrade.symbol, direction: closedTrade.direction, closeReason, holdMs, pnl: { grossPnlPct: closedTrade.grossPnlPct, netPnlPct: closedTrade.netPnlPct, grossPnlUsd: closedTrade.grossPnlUsd, netPnlUsd: closedTrade.netPnlUsd, totalCostsPct: costs }, risk: { consecutiveStops: risk.consecutiveStops, cooldownUntil: new Date(risk.cooldownUntil).toISOString(), bannedUntil: risk.bannedUntil > now ? new Date(risk.bannedUntil).toISOString() : undefined }, depositBeforeClose, depositAfterClose, configuration: { maxEntrySpreadPct: MAX_ENTRY_SPREAD_PCT, maxEntryMexcBookSpreadPct: MAX_ENTRY_MEXC_BOOK_SPREAD_PCT, maxDexAnchorAgeMs: config.maxDexAnchorAgeMs, anchorBreakDistancePct: ANCHOR_BREAK_DISTANCE_PCT, maxAnchorBreakLossPct: MAX_ANCHOR_BREAK_LOSS_PCT, anchorLossMinHoldMs: ANCHOR_LOSS_MIN_HOLD_MS, initialStopDurationMs: INITIAL_STOP_DURATION_MS, initialStopDistancePct: INITIAL_STOP_DISTANCE_PCT, regularStopDistancePct: REGULAR_STOP_DISTANCE_PCT, entryMomentumWindowMs: ENTRY_MOMENTUM_WINDOW_MS, longEntryMomentumBlockPct: LONG_ENTRY_MOMENTUM_BLOCK_PCT, shortEntryMomentumBlockPct: SHORT_ENTRY_MOMENTUM_BLOCK_PCT, minNetProfitPct: MIN_NET_PROFIT_PCT } }, "PAPER TRADE CLOSED");
    return { action: "CLOSE", trade: closedTrade };
  }
}
