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

export type SignalAction = "long" | "short";

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
