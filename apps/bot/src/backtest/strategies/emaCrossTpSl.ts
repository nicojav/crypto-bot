import { ema, atr, crossover, crossunder } from "../indicators.js";
import type { StrategyDefinition, SignalEvent } from "./types.js";

// Mirrors strategies/ema-cross-tpsl.pine — EMA crossover with ATR-multiple TP/SL,
// captured at the entry bar (SL/TP = close ∓/± atr*mult).
export const emaCrossTpSl: StrategyDefinition = {
  id: "emaCrossTpSl",
  label: "EMA Cross Bot TP/SL",
  description: "EMA crossover with ATR-based take-profit/stop-loss (2:1 R:R by default).",
  params: [
    { name: "fastLen", label: "Fast EMA", default: 20, min: 2, max: 200, step: 1 },
    { name: "slowLen", label: "Slow EMA", default: 50, min: 5, max: 400, step: 1 },
    { name: "atrLen", label: "ATR length", default: 14, min: 1, max: 100, step: 1 },
    { name: "slMult", label: "SL ATR mult", default: 1.5, min: 0.1, max: 10, step: 0.1 },
    { name: "tpMult", label: "TP ATR mult", default: 3.0, min: 0.1, max: 10, step: 0.1 },
  ],
  run(candles, params) {
    const fastLen = params.fastLen ?? 20;
    const slowLen = params.slowLen ?? 50;
    const atrLen = params.atrLen ?? 14;
    const slMult = params.slMult ?? 1.5;
    const tpMult = params.tpMult ?? 3.0;

    const closes = candles.map((c) => c.close);
    const emaFast = ema(closes, fastLen);
    const emaSlow = ema(closes, slowLen);
    const atrSeries = atr(candles, atrLen);

    const events: SignalEvent[] = [];
    for (let i = 0; i < candles.length; i++) {
      const atrVal = atrSeries[i];
      if (atrVal == null) continue; // ATR not warmed up yet — Pine wouldn't fire either
      if (crossover(emaFast, emaSlow, i)) {
        events.push({ barIndex: i, time: candles[i]!.openTime, action: "long", tpAtrMult: tpMult, slAtrMult: slMult, atrAtSignal: atrVal });
      } else if (crossunder(emaFast, emaSlow, i)) {
        events.push({ barIndex: i, time: candles[i]!.openTime, action: "short", tpAtrMult: tpMult, slAtrMult: slMult, atrAtSignal: atrVal });
      }
    }
    return events;
  },
};
