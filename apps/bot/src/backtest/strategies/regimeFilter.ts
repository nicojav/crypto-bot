import { adx, atr, rollingPercentile } from "../indicators.js";
import { isWithinUtcHours } from "../sessions.js";
import type { Candle } from "../types.js";
import type { StrategyParamDef } from "./types.js";

// Regime mode indices — kept in sync with the `regimeMode` param's `options` labels below.
export const REGIME_OFF = 0;
export const REGIME_TRENDING = 1;
export const REGIME_RANGING = 2;
export const REGIME_VOLATILE = 3;

const SESSION_OFF = 0;

/**
 * Shared "when is it worth trading at all" gate, opted into by a strategy spreading
 * REGIME_PARAM_DEFS into its own `params` and calling buildRegimeGate in `run()`.
 *
 * This exists because the original strategy set had no such concept: every one of them fired on
 * every crossover regardless of conditions. That is survivable on daily bars, where a handful of
 * real trends per year carry the cost of the noise, and fatal on 5m, where the same logic fires
 * hundreds of times more often into the same ~15bps round-trip cost. Gating *when* a strategy is
 * allowed to trade is a bigger lever on intraday timeframes than the entry rule itself.
 *
 * Deliberately kept to two enums and three numerics. `buildCoarseGrid` fully expands every enum
 * param into its own branch and splits the combo budget across them, so each added enum
 * multiplies the branch count and thins the sampling for the whole strategy — see the
 * minCombosPerBranch floor in search.ts, which exists to keep that from starving the search.
 */
export const REGIME_PARAM_DEFS: StrategyParamDef[] = [
  {
    name: "regimeMode",
    label: "Regime filter",
    default: REGIME_OFF,
    min: 0,
    max: 3,
    step: 1,
    options: ["Off", "Trending (ADX ≥)", "Ranging (ADX ≤)", "Volatile (ATR pctile ≥)"],
  },
  { name: "regimeLen", label: "Regime length", default: 14, min: 2, max: 100, step: 1 },
  { name: "regimeThreshold", label: "Regime threshold", default: 25, min: 1, max: 100, step: 1 },
  {
    name: "useSessionFilter",
    label: "Session filter",
    default: SESSION_OFF,
    min: 0,
    max: 1,
    step: 1,
    options: ["Off", "On"],
  },
  { name: "sessionStartHourUtc", label: "Session start (UTC h)", default: 13, min: 0, max: 23, step: 1, showIf: { param: "useSessionFilter", equals: 1 } },
  { name: "sessionEndHourUtc", label: "Session end (UTC h)", default: 21, min: 0, max: 23, step: 1, showIf: { param: "useSessionFilter", equals: 1 } },
];

/**
 * Precomputes whichever series the configured mode needs (once, not per bar) and returns a cheap
 * per-bar predicate. Returns a constant-true predicate when the filter is fully off, so callers
 * can apply it unconditionally without branching.
 *
 * Bars where the gating indicator hasn't warmed up yet are rejected rather than allowed — an
 * ungated signal is exactly what the filter exists to prevent, so warmup should suppress trades,
 * not wave them through.
 */
export function buildRegimeGate(candles: readonly Candle[], params: Record<string, number>): (i: number) => boolean {
  const mode = params.regimeMode ?? REGIME_OFF;
  const len = params.regimeLen ?? 14;
  const threshold = params.regimeThreshold ?? 25;
  const sessionOn = (params.useSessionFilter ?? SESSION_OFF) === 1;
  const startHour = params.sessionStartHourUtc ?? 13;
  const endHour = params.sessionEndHourUtc ?? 21;

  const sessionAllows = sessionOn
    ? (i: number) => isWithinUtcHours(candles[i]!.openTime, startHour, endHour)
    : () => true;

  if (mode === REGIME_OFF) return sessionAllows;

  if (mode === REGIME_VOLATILE) {
    // Percentile of ATR against its own recent history rather than a raw ATR threshold: an
    // absolute cutoff would mean something completely different on BTC in 2024 than on DOGE in
    // 2026, and would need re-fitting per symbol and per era. A percentile transfers.
    const atrSeries = atr(candles, len);
    const pctile = rollingPercentile(atrSeries, Math.max(len * 4, 20));
    return (i: number) => {
      const p = pctile[i];
      return p != null && p >= threshold && sessionAllows(i);
    };
  }

  const adxSeries = adx(candles, len);
  const wantsTrend = mode === REGIME_TRENDING;
  return (i: number) => {
    const a = adxSeries[i];
    if (a == null) return false;
    const regimeOk = wantsTrend ? a >= threshold : a <= threshold;
    return regimeOk && sessionAllows(i);
  };
}
