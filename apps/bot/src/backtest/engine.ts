import { calcQty, roundToTick } from "../processor/signalProcessor.js";
import type { Candle } from "./types.js";
import type { SignalEvent } from "./strategies/types.js";

export type ExitReason = "tp" | "sl" | "reversal" | "windowEnd";

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
  barsHeld: number;
  exitReason: ExitReason;
}

export interface EquityPoint {
  time: number;
  equity: number;
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
}

export interface EngineResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  buyHoldCurve: EquityPoint[];
}

interface OpenPosition {
  side: "BUY" | "SELL";
  qty: number;
  entryPrice: number;
  entryTime: number;
  entryBarIndex: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  feeOpenUsd: number;
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

function buildPosition(signal: SignalEvent, rawFillPrice: number, fillTime: number, barIndex: number, config: EngineConfig, feeRate: number, slippageRate: number): OpenPosition | null {
  const side: "BUY" | "SELL" = signal.action === "long" ? "BUY" : "SELL";
  const adj = rawFillPrice * slippageRate;
  const fillPrice = side === "BUY" ? rawFillPrice + adj : rawFillPrice - adj;
  const qty = calcQty(config.maxPositionUsd, config.leverage, fillPrice, config.lotSize);
  if (qty <= 0) return null; // position too small to open at this size/price — signal skipped, matches live calcQty guard

  const { tp, sl } = resolveBracket(signal, fillPrice, config.tickSize);
  const feeOpenUsd = fillPrice * qty * feeRate;
  return { side, qty, entryPrice: fillPrice, entryTime: fillTime, entryBarIndex: barIndex, takeProfitPrice: tp, stopLossPrice: sl, feeOpenUsd };
}

// TP/SL fills at the exact touched level — no slippage modeled there. Signal-driven exits
// (reversal/windowEnd) are market-order fills, so slippage applies against the closing side.
function resolveExitPrice(position: OpenPosition, rawExitPrice: number, exitReason: ExitReason, slippageRate: number): number {
  if (exitReason === "tp" || exitReason === "sl") return rawExitPrice;
  const adj = rawExitPrice * slippageRate;
  return position.side === "BUY" ? rawExitPrice - adj : rawExitPrice + adj;
}

function buildTrade(position: OpenPosition, exitPrice: number, exitTime: number, exitBarIndex: number, exitReason: ExitReason, feeRate: number): BacktestTrade {
  const grossPnl = (exitPrice - position.entryPrice) * position.qty * (position.side === "BUY" ? 1 : -1);
  const feeCloseUsd = exitPrice * position.qty * feeRate;
  const netPnl = grossPnl - position.feeOpenUsd - feeCloseUsd;
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
    barsHeld: exitBarIndex - position.entryBarIndex,
    exitReason,
  };
}

/**
 * Deterministic single-position backtest simulator — mirrors the live bot's own execution
 * math (calcQty/roundToTick, direction-aware %/ATR TP-SL re-anchored to the fill price) so
 * results reflect how *this bot* would have traded, not TradingView's Strategy Tester.
 *
 * TP/SL touch checks assume SL fires first when a single bar's high/low could hit both
 * (conservative).
 */
export function runBacktestEngine(candles: readonly Candle[], signals: readonly SignalEvent[], config: EngineConfig): EngineResult {
  const signalsByBar = new Map<number, SignalEvent>();
  for (const s of signals) signalsByBar.set(s.barIndex, s);

  const feeRate = config.feeBps / 10_000;
  const slippageRate = config.slippageBps / 10_000;

  let cash = config.initialCapital;
  let position: OpenPosition | null = null;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  const nextBarOpen = (i: number): number | null => (i + 1 < candles.length ? candles[i + 1]!.open : null);

  const resolveFillPrice = (i: number): number | null =>
    config.fillModel === "signalClose" ? candles[i]!.close : nextBarOpen(i);

  const resolveFillTime = (i: number): number =>
    config.fillModel === "signalClose" ? candles[i]!.openTime : candles[i + 1]!.openTime;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]!;

    // a) Check TP/SL touch for a position opened on a prior bar. SL-first when both would hit.
    if (position) {
      const hitSl =
        position.stopLossPrice != null &&
        (position.side === "BUY" ? bar.low <= position.stopLossPrice : bar.high >= position.stopLossPrice);
      const hitTp =
        position.takeProfitPrice != null &&
        (position.side === "BUY" ? bar.high >= position.takeProfitPrice : bar.low <= position.takeProfitPrice);

      if (hitSl) {
        const exitPrice = resolveExitPrice(position, position.stopLossPrice!, "sl", slippageRate);
        const trade = buildTrade(position, exitPrice, bar.openTime, i, "sl", feeRate);
        cash += trade.pnlUsd;
        trades.push(trade);
        position = null;
      } else if (hitTp) {
        const exitPrice = resolveExitPrice(position, position.takeProfitPrice!, "tp", slippageRate);
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
          const exitPrice = resolveExitPrice(position, fillPriceRaw, "reversal", slippageRate);
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
      const exitPrice = resolveExitPrice(position, bar.close, "windowEnd", slippageRate);
      const trade = buildTrade(position, exitPrice, bar.openTime, i, "windowEnd", feeRate);
      cash += trade.pnlUsd;
      trades.push(trade);
      position = null;
    }

    const unrealized = position ? (bar.close - position.entryPrice) * position.qty * (position.side === "BUY" ? 1 : -1) : 0;
    equityCurve.push({ time: bar.openTime, equity: cash + unrealized });
  }

  const firstClose = candles[0]?.close ?? 1;
  const buyHoldCurve: EquityPoint[] = candles.map((c) => ({
    time: c.openTime,
    equity: config.initialCapital * (c.close / firstClose),
  }));

  return { trades, equityCurve, buyHoldCurve };
}
