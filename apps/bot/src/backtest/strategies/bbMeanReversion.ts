import { sma, stddev, rsi, atr, crossover, crossunder } from "../indicators.js";
import { pineForBbMeanReversion } from "./pineExport.js";
import { REGIME_PARAM_DEFS, buildRegimeGate } from "./regimeFilter.js";
import type { StrategyDefinition, SignalEvent, SignalAction } from "./types.js";

// TP/SL mode indices (kept in sync with the `tpslMode` param's `options` labels below).
const TPSL_NONE = 0;
const TPSL_ATR = 1;
const TPSL_PCT = 2;

// Bollinger Band mean-reversion — a genuinely different signal shape from the trend-following
// EMA/SMA-cross strategies: fades noise instead of riding it, suited to short/choppy
// timeframes where crossover strategies whipsaw badly. Price closing below the lower band is
// the long trigger (bet on reversion to the mean), above the upper band is the short trigger.
// Optional RSI confirmation requires momentum agrees the move is extended (oversold/overbought)
// — the opposite polarity from customMaCross's "avoid overbought" trend-following filter.
export const bbMeanReversion: StrategyDefinition = {
  id: "bbMeanReversion",
  label: "BB Mean Reversion",
  description: "Bollinger Band touch/breach scalper: fades price back toward the mean, with optional RSI oversold/overbought confirmation and a choice of no bracket / ATR-multiple / percentage TP-SL.",
  params: [
    { name: "bbLen", label: "BB length", default: 20, min: 5, max: 100, step: 1 },
    { name: "bbMult", label: "BB std-dev mult", default: 2.0, min: 0.5, max: 5, step: 0.1 },
    { name: "useRsiConfirm", label: "RSI confirm", default: 1, min: 0, max: 1, step: 1, options: ["Off", "On"] },
    { name: "rsiLen", label: "RSI length", default: 14, min: 2, max: 100, step: 1, showIf: { param: "useRsiConfirm", equals: 1 } },
    { name: "rsiOversold", label: "RSI oversold", default: 30, min: 1, max: 100, step: 1, showIf: { param: "useRsiConfirm", equals: 1 } },
    { name: "rsiOverbought", label: "RSI overbought", default: 70, min: 1, max: 100, step: 1, showIf: { param: "useRsiConfirm", equals: 1 } },
    { name: "tpslMode", label: "TP/SL mode", default: TPSL_NONE, min: 0, max: 2, step: 1, options: ["None", "ATR multiple", "Percentage"] },
    { name: "atrLen", label: "ATR length", default: 14, min: 1, max: 100, step: 1, showIf: { param: "tpslMode", equals: TPSL_ATR } },
    { name: "slAtrMult", label: "SL ATR mult", default: 1.5, min: 0.1, max: 10, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_ATR } },
    { name: "tpAtrMult", label: "TP ATR mult", default: 3.0, min: 0.1, max: 10, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_ATR } },
    { name: "tpPct", label: "TP %", default: 1.5, min: 0.1, max: 50, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_PCT } },
    { name: "slPct", label: "SL %", default: 0.75, min: 0.1, max: 50, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_PCT } },
    // Fading every band breach is this strategy's core weakness — a breach during a trending
    // impulse is exactly when fading loses most. The gate defaults to Off so existing configs are
    // unchanged; set regimeMode to "Ranging" to only fade when the market is actually ranging.
    ...REGIME_PARAM_DEFS,
  ],
  run(candles, params) {
    const bbLen = params.bbLen ?? 20;
    const bbMult = params.bbMult ?? 2.0;
    const useRsiConfirm = (params.useRsiConfirm ?? 1) === 1;
    const rsiLen = params.rsiLen ?? 14;
    const rsiOversold = params.rsiOversold ?? 30;
    const rsiOverbought = params.rsiOverbought ?? 70;
    const tpslMode = params.tpslMode ?? TPSL_NONE;
    const atrLen = params.atrLen ?? 14;
    const slAtrMult = params.slAtrMult ?? 1.5;
    const tpAtrMult = params.tpAtrMult ?? 3.0;
    const tpPct = params.tpPct ?? 1.5;
    const slPct = params.slPct ?? 0.75;

    const closes = candles.map((c) => c.close);
    const basis = sma(closes, bbLen);
    const dev = stddev(closes, bbLen);
    const upperBand = basis.map((b, i) => (b == null || dev[i] == null ? null : b + dev[i]! * bbMult));
    const lowerBand = basis.map((b, i) => (b == null || dev[i] == null ? null : b - dev[i]! * bbMult));

    const rsiSeries = useRsiConfirm ? rsi(closes, rsiLen) : null;
    const atrSeries = tpslMode === TPSL_ATR ? atr(candles, atrLen) : null;
    const regimeAllows = buildRegimeGate(candles, params);

    const events: SignalEvent[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (upperBand[i] == null || lowerBand[i] == null) continue; // bands not warmed up yet
      if (!regimeAllows(i)) continue; // conditions don't favor fading right now — see regimeFilter.ts
      if (useRsiConfirm && rsiSeries![i] == null) continue; // RSI not warmed up yet
      if (tpslMode === TPSL_ATR && atrSeries![i] == null) continue; // ATR not warmed up yet

      const isLongTrigger = crossunder(closes, lowerBand, i); // price closed below the lower band
      const isShortTrigger = crossover(closes, upperBand, i); // price closed above the upper band
      if (!isLongTrigger && !isShortTrigger) continue;

      if (useRsiConfirm) {
        const rsiVal = rsiSeries![i]!;
        if (isLongTrigger && !(rsiVal < rsiOversold)) continue;
        if (isShortTrigger && !(rsiVal > rsiOverbought)) continue;
      }

      const action: SignalAction = isLongTrigger ? "long" : "short";
      const event: SignalEvent = { barIndex: i, time: candles[i]!.openTime, action };
      if (tpslMode === TPSL_ATR) {
        event.tpAtrMult = tpAtrMult;
        event.slAtrMult = slAtrMult;
        event.atrAtSignal = atrSeries![i]!;
      } else if (tpslMode === TPSL_PCT) {
        event.tpPct = tpPct;
        event.slPct = slPct;
      }
      events.push(event);
    }
    return events;
  },
  toPine(params) {
    return pineForBbMeanReversion(params);
  },
};
