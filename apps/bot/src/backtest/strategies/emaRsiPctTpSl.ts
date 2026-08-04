import { ema, rsi, crossover, crossunder } from "../indicators.js";
import type { StrategyDefinition, SignalEvent } from "./types.js";

// Mirrors strategies/ema-rsi-pct-tpsl.pine — EMA crossover + RSI filter, with TP/SL as a
// percentage of the fill price (the same math the live bot applies to the mark price).
export const emaRsiPctTpSl: StrategyDefinition = {
  id: "emaRsiPctTpSl",
  label: "EMA+RSI Bot (% TP/SL)",
  description: "EMA crossover filtered by RSI, with take-profit/stop-loss as a percentage of the fill price.",
  params: [
    { name: "fastLen", label: "Fast EMA", default: 9, min: 2, max: 200, step: 1 },
    { name: "slowLen", label: "Slow EMA", default: 21, min: 5, max: 400, step: 1 },
    { name: "rsiLen", label: "RSI length", default: 14, min: 2, max: 100, step: 1 },
    { name: "rsiMaxForLong", label: "RSI max for long", default: 60, min: 1, max: 100, step: 1 },
    { name: "rsiMinForShort", label: "RSI min for short", default: 40, min: 1, max: 100, step: 1 },
    { name: "tpPct", label: "TP %", default: 1.5, min: 0.1, max: 50, step: 0.1 },
    { name: "slPct", label: "SL %", default: 0.75, min: 0.1, max: 50, step: 0.1 },
  ],
  run(candles, params) {
    const fastLen = params.fastLen ?? 9;
    const slowLen = params.slowLen ?? 21;
    const rsiLen = params.rsiLen ?? 14;
    const rsiMaxForLong = params.rsiMaxForLong ?? 60;
    const rsiMinForShort = params.rsiMinForShort ?? 40;
    const tpPct = params.tpPct ?? 1.5;
    const slPct = params.slPct ?? 0.75;

    const closes = candles.map((c) => c.close);
    const emaFast = ema(closes, fastLen);
    const emaSlow = ema(closes, slowLen);
    const rsiSeries = rsi(closes, rsiLen);

    const events: SignalEvent[] = [];
    for (let i = 0; i < candles.length; i++) {
      const rsiVal = rsiSeries[i];
      if (rsiVal == null) continue; // RSI not warmed up yet — Pine wouldn't fire either
      if (crossover(emaFast, emaSlow, i) && rsiVal < rsiMaxForLong) {
        events.push({ barIndex: i, time: candles[i]!.openTime, action: "long", tpPct, slPct });
      } else if (crossunder(emaFast, emaSlow, i) && rsiVal > rsiMinForShort) {
        events.push({ barIndex: i, time: candles[i]!.openTime, action: "short", tpPct, slPct });
      }
    }
    return events;
  },
};
