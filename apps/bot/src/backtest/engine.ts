import { calcQty, roundToTick } from "../processor/signalProcessor.js";
import type { Candle } from "./types.js";
import type { SignalEvent } from "./strategies/types.js";

export type ExitReason = "tp" | "sl" | "liquidation" | "reversal" | "windowEnd";

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sizeUsd: number;
  pnlUsd: number;
  /** Simple price return (entry→exit), not fee- or leverage-adjusted — matches the TradingView "Return" column. */
  pnlPct: number;
  feeUsd: number;
  /** Funding paid (positive) or received (negative) over the position's life — see FundingRatePoint. Already netted into pnlUsd; broken out here for transparency. */
  fundingUsd: number;
  barsHeld: number;
  exitReason: ExitReason;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

/** One funding settlement — Bybit perpetuals settle funding periodically (typically every 8h)
 * against any open position's notional value. `rate` follows Bybit's convention: positive means
 * longs pay shorts, negative means shorts pay longs. */
export interface FundingRatePoint {
  time: number;
  rate: number;
}

export interface EngineConfig {
  initialCapital: number;
  /** Margin per trade — mirrors the bot's Bot.maxPositionUsd (actual notional = this × leverage). */
  maxPositionUsd: number;
  leverage: number;
  feeBps: number;
  slippageBps: number;
  fillModel: "signalClose" | "nextOpen";
  lotSize: number;
  tickSize: number;
  /** When set, a position is force-closed once its mark-to-market loss breaches this fraction of
   * notional — an approximation of exchange liquidation (isolated-margin style: entryPrice × (1 ∓
   * 1/leverage ± maintenanceMarginRate)). Omit to skip the check entirely (pre-existing behavior). */
  maintenanceMarginRate?: number;
  /** Funding settlements to accrue against open positions, sorted ascending by time. Omit for no
   * funding cost (pre-existing behavior) — see FundingRatePoint. */
  fundingRates?: readonly FundingRatePoint[];
}

export interface EngineResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  buyHoldCurve: EquityPoint[];
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
}

interface OpenPosition {
  side: "BUY" | "SELL";
  qty: number;
  entryPrice: number;
  entryTime: number;
  entryBarIndex: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  liquidationPrice: number | null;
  feeOpenUsd: number;
  /** Running total of funding accrued while this position has been open — see FundingRatePoint. */
  fundingPaidUsd: number;
}

function resolveBracket(signal: SignalEvent, fillPrice: number, tickSize: number): { tp: number | null; sl: number | null } {
  if (signal.tpPct != null && signal.slPct != null) {
    const tp = signal.action === "long" ? fillPrice * (1 + signal.tpPct / 100) : fillPrice * (1 - signal.tpPct / 100);
    const sl = signal.action === "long" ? fillPrice * (1 - signal.slPct / 100) : fillPrice * (1 + signal.slPct / 100);
    return { tp: roundToTick(tp, tickSize), sl: roundToTick(sl, tickSize) };
  }
  if (signal.tpAtrMult != null && signal.slAtrMult != null && signal.atrAtSignal != null) {
    const offset = signal.atrAtSignal;
    const tp = signal.action === "long" ? fillPrice + offset * signal.tpAtrMult : fillPrice - offset * signal.tpAtrMult;
    const sl = signal.action === "long" ? fillPrice - offset * signal.slAtrMult : fillPrice + offset * signal.slAtrMult;
    return { tp: roundToTick(tp, tickSize), sl: roundToTick(sl, tickSize) };
  }
  return { tp: null, sl: null };
}

/** Approximate isolated-margin liquidation price. Ignores the insurance fund, partial
 * liquidation tiers, and funding's effect on margin balance — a deliberately simple model that's
 * still strictly better than the previous "no check at all". Null when maintenanceMarginRate
 * isn't configured, or leverage is 1 (no liquidation risk to model). */
function resolveLiquidationPrice(side: "BUY" | "SELL", fillPrice: number, leverage: number, maintenanceMarginRate: number | undefined): number | null {
  if (maintenanceMarginRate == null || leverage <= 1) return null;
  const cushion = 1 / leverage - maintenanceMarginRate;
  if (cushion <= 0) return null; // maintenance margin already exceeds the position's own margin — degenerate config, skip rather than produce a nonsensical price
  return side === "BUY" ? fillPrice * (1 - cushion) : fillPrice * (1 + cushion);
}

function buildPosition(signal: SignalEvent, rawFillPrice: number, fillTime: number, barIndex: number, config: EngineConfig, feeRate: number, slippageRate: number): OpenPosition | null {
  const side: "BUY" | "SELL" = signal.action === "long" ? "BUY" : "SELL";
  const adj = rawFillPrice * slippageRate;
  const fillPrice = side === "BUY" ? rawFillPrice + adj : rawFillPrice - adj;
  const qty = calcQty(config.maxPositionUsd, config.leverage, fillPrice, config.lotSize);
  if (qty <= 0) return null; // position too small to open at this size/price — signal skipped, matches live calcQty guard

  const { tp, sl } = resolveBracket(signal, fillPrice, config.tickSize);
  const liquidationPrice = resolveLiquidationPrice(side, fillPrice, config.leverage, config.maintenanceMarginRate);
  const feeOpenUsd = fillPrice * qty * feeRate;
  return { side, qty, entryPrice: fillPrice, entryTime: fillTime, entryBarIndex: barIndex, takeProfitPrice: tp, stopLossPrice: sl, liquidationPrice, feeOpenUsd, fundingPaidUsd: 0 };
}

// TP fills at the exact touched level — no slippage modeled there (optimistic exits aren't the
// risk this models). SL and liquidation fills slip through the trigger level and handle a bar
// that gaps straight past it (barOpen already beyond the stop) by filling at the worse of the
// two. Signal-driven exits (reversal/windowEnd) are market-order fills, slippage against the
// closing side.
function resolveExitPrice(position: OpenPosition, rawExitPrice: number, exitReason: ExitReason, barOpen: number, slippageRate: number): number {
  if (exitReason === "tp") return rawExitPrice;
  if (exitReason === "sl" || exitReason === "liquidation") {
    const gapped = position.side === "BUY" ? Math.min(barOpen, rawExitPrice) : Math.max(barOpen, rawExitPrice);
    const adj = gapped * slippageRate;
    return position.side === "BUY" ? gapped - adj : gapped + adj;
  }
  const adj = rawExitPrice * slippageRate;
  return position.side === "BUY" ? rawExitPrice - adj : rawExitPrice + adj;
}

function buildTrade(position: OpenPosition, exitPrice: number, exitTime: number, exitBarIndex: number, exitReason: ExitReason, feeRate: number): BacktestTrade {
  const grossPnl = (exitPrice - position.entryPrice) * position.qty * (position.side === "BUY" ? 1 : -1);
  const feeCloseUsd = exitPrice * position.qty * feeRate;
  const netPnl = grossPnl - position.feeOpenUsd - feeCloseUsd - position.fundingPaidUsd;
  return {
    entryTime: position.entryTime,
    exitTime,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    qty: position.qty,
    sizeUsd: position.entryPrice * position.qty,
    pnlUsd: netPnl,
    pnlPct: ((exitPrice - position.entryPrice) / position.entryPrice) * (position.side === "BUY" ? 1 : -1) * 100,
    feeUsd: position.feeOpenUsd + feeCloseUsd,
    fundingUsd: position.fundingPaidUsd,
    barsHeld: exitBarIndex - position.entryBarIndex,
    exitReason,
  };
}

/** Mark-to-market equity for the current cash baseline and an optional open position, evaluated
 * at `price` — nets out the position's own opening fee and funding paid so far, so equity while
 * holding reflects costs already incurred rather than only the raw price move. */
function markToMarket(position: OpenPosition | null, cash: number, price: number): number {
  if (!position) return cash;
  const priceComponent = (price - position.entryPrice) * position.qty * (position.side === "BUY" ? 1 : -1);
  return cash + priceComponent - position.feeOpenUsd - position.fundingPaidUsd;
}

/**
 * Deterministic single-position backtest simulator — mirrors the live bot's own execution
 * math (calcQty/roundToTick, direction-aware %/ATR TP-SL re-anchored to the fill price) so
 * results reflect how *this bot* would have traded, not TradingView's Strategy Tester.
 *
 * Priority when multiple exits could trigger on the same bar: liquidation > SL > TP — a real
 * exchange forces liquidation regardless of the trader's own SL/TP, and (like the existing SL-
 * over-TP rule) a single bar's high/low touching both is resolved conservatively.
 */
export function runBacktestEngine(candles: readonly Candle[], signals: readonly SignalEvent[], config: EngineConfig): EngineResult {
  const signalsByBar = new Map<number, SignalEvent>();
  for (const s of signals) signalsByBar.set(s.barIndex, s);

  const feeRate = config.feeBps / 10_000;
  const slippageRate = config.slippageBps / 10_000;
  const fundingRates = config.fundingRates ?? [];

  let cash = config.initialCapital;
  let position: OpenPosition | null = null;
  let fundingIdx = 0;
  let peakEquity = config.initialCapital;
  let maxDdAbs = 0;
  let maxDdPct = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  const nextBarOpen = (i: number): number | null => (i + 1 < candles.length ? candles[i + 1]!.open : null);

  const resolveFillPrice = (i: number): number | null =>
    config.fillModel === "signalClose" ? candles[i]!.close : nextBarOpen(i);

  const resolveFillTime = (i: number): number =>
    config.fillModel === "signalClose" ? candles[i]!.openTime : candles[i + 1]!.openTime;

  const trackDrawdown = (favorableEquity: number, adverseEquity: number) => {
    if (favorableEquity > peakEquity) peakEquity = favorableEquity;
    const dd = peakEquity - adverseEquity;
    if (dd > maxDdAbs) maxDdAbs = dd;
    const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]!;
    const positionAtBarStart = position; // what was actually exposed to this bar's high/low range

    // Funding settles at fixed wall-clock times regardless of candle boundaries — accrue every
    // settlement up to this bar's open against whatever position is open at that moment. A 1d/1w
    // bar can span several settlements, so this is a loop, not a single check.
    while (fundingIdx < fundingRates.length && fundingRates[fundingIdx]!.time <= bar.openTime) {
      const funding = fundingRates[fundingIdx]!;
      if (position) {
        const notional = position.qty * bar.open;
        const cost = position.side === "BUY" ? notional * funding.rate : -notional * funding.rate;
        position.fundingPaidUsd += cost;
      }
      fundingIdx++;
    }

    // a) Check liquidation, then TP/SL touch for a position opened on a prior bar.
    if (position) {
      const hitLiquidation =
        position.liquidationPrice != null &&
        (position.side === "BUY" ? bar.low <= position.liquidationPrice : bar.high >= position.liquidationPrice);
      const hitSl =
        !hitLiquidation &&
        position.stopLossPrice != null &&
        (position.side === "BUY" ? bar.low <= position.stopLossPrice : bar.high >= position.stopLossPrice);
      const hitTp =
        !hitLiquidation &&
        !hitSl &&
        position.takeProfitPrice != null &&
        (position.side === "BUY" ? bar.high >= position.takeProfitPrice : bar.low <= position.takeProfitPrice);

      if (hitLiquidation) {
        const exitPrice = resolveExitPrice(position, position.liquidationPrice!, "liquidation", bar.open, slippageRate);
        const trade = buildTrade(position, exitPrice, bar.openTime, i, "liquidation", feeRate);
        cash += trade.pnlUsd;
        trades.push(trade);
        position = null;
      } else if (hitSl) {
        const exitPrice = resolveExitPrice(position, position.stopLossPrice!, "sl", bar.open, slippageRate);
        const trade = buildTrade(position, exitPrice, bar.openTime, i, "sl", feeRate);
        cash += trade.pnlUsd;
        trades.push(trade);
        position = null;
      } else if (hitTp) {
        const exitPrice = resolveExitPrice(position, position.takeProfitPrice!, "tp", bar.open, slippageRate);
        const trade = buildTrade(position, exitPrice, bar.openTime, i, "tp", feeRate);
        cash += trade.pnlUsd;
        trades.push(trade);
        position = null;
      }
    }

    // b) Process this bar's signal, if any — reversal closes the opposite side first, then opens.
    const signal = signalsByBar.get(i);
    if (signal) {
      const fillPriceRaw = resolveFillPrice(i);
      if (fillPriceRaw != null) {
        const fillTime = resolveFillTime(i);
        const desiredSide: "BUY" | "SELL" = signal.action === "long" ? "BUY" : "SELL";

        if (position && position.side !== desiredSide) {
          const exitPrice = resolveExitPrice(position, fillPriceRaw, "reversal", bar.open, slippageRate);
          const trade = buildTrade(position, exitPrice, fillTime, i, "reversal", feeRate);
          cash += trade.pnlUsd;
          trades.push(trade);
          position = null;
        }
        if (!position) {
          position = buildPosition(signal, fillPriceRaw, fillTime, i, config, feeRate, slippageRate);
        }
      }
    }

    // c) Flatten any open position at the end of the backtest window (mirrors the Pine
    //    date-range strategies' "Date window end" flatten so results report cleanly).
    if (i === candles.length - 1 && position) {
      const exitPrice = resolveExitPrice(position, bar.close, "windowEnd", bar.open, slippageRate);
      const trade = buildTrade(position, exitPrice, bar.openTime, i, "windowEnd", feeRate);
      cash += trade.pnlUsd;
      trades.push(trade);
      position = null;
    }

    equityCurve.push({ time: bar.openTime, equity: markToMarket(position, cash, bar.close) });

    // Intrabar drawdown — a position can swing further against (or in favor of) the holder
    // within a single bar than its close reveals; close-only tracking understates real max
    // drawdown. Uses whichever position was open at the START of this bar, since that's what was
    // actually exposed to its high/low range (a position opened mid-bar wasn't).
    if (positionAtBarStart) {
      const favorablePrice = positionAtBarStart.side === "BUY" ? bar.high : bar.low;
      const adversePrice = positionAtBarStart.side === "BUY" ? bar.low : bar.high;
      trackDrawdown(markToMarket(positionAtBarStart, cash, favorablePrice), markToMarket(positionAtBarStart, cash, adversePrice));
    } else {
      const flatEquity = markToMarket(position, cash, bar.close);
      trackDrawdown(flatEquity, flatEquity);
    }
  }

  const firstClose = candles[0]?.close ?? 1;
  const buyHoldCurve: EquityPoint[] = candles.map((c) => ({
    time: c.openTime,
    equity: config.initialCapital * (c.close / firstClose),
  }));

  return { trades, equityCurve, buyHoldCurve, maxDrawdownUsd: maxDdAbs, maxDrawdownPct: maxDdPct };
}
