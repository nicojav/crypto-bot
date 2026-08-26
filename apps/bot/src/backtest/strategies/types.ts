import type { Candle } from "../types.js";

export interface StrategyParamDef {
  name: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  /**
   * When present, this param is an enum: the stored/underlying value is still a plain
   * number (the index into this list) — only the UI renders it as a select instead of a
   * numeric field. Keeps the params pipeline (Record<string, number> end to end) unchanged.
   */
  options?: string[];
  /** Only show this param in the UI when `params[param] === equals`. Rendering hint only. */
  showIf?: { param: string; equals: number };
}

/**
 * "flat" closes any open position without opening a new one — the backtest counterpart of the
 * live webhook's CLOSE action (see routes/webhook.ts and SignalProcessor). Intraday strategies
 * need it for exits that a static TP price can't express: flattening at session end, or exiting
 * into a moving target like session VWAP.
 *
 * Because `run()` has no visibility into position state, strategies emit "flat" unconditionally
 * whenever their exit condition holds; the engine no-ops the ones where nothing is open. That
 * redundancy is deliberate — it's what keeps strategies stateless.
 */
export type SignalAction = "long" | "short" | "flat";

export interface SignalEvent {
  barIndex: number;
  time: number;
  action: SignalAction;
  /** Percentage TP/SL (applied to fill price, direction-aware) — used by %-based strategies. */
  tpPct?: number;
  slPct?: number;
  /** ATR-multiple TP/SL (resolved to absolute prices by the engine at fill time) — used by ATR-based strategies. */
  tpAtrMult?: number;
  slAtrMult?: number;
  atrAtSignal?: number;
  /**
   * Time stop: force-close the position this signal opens once it has been held this many bars.
   * Checked after the price-triggered exits, so an SL/TP touch on the same bar still wins. Caps
   * how long capital (and funding exposure) sits in a trade that never resolved either way —
   * essential on intraday timeframes, where a dead position otherwise rides to `windowEnd`.
   */
  maxBarsHeld?: number;
}

export interface StrategyDefinition {
  id: string;
  label: string;
  description: string;
  params: StrategyParamDef[];
  run(candles: readonly Candle[], params: Record<string, number>): SignalEvent[];
  /** Optional: generate an equivalent .pine file for this strategy + config, for promoting a winning backtest to live TradingView. */
  toPine?(params: Record<string, number>): string;
}
