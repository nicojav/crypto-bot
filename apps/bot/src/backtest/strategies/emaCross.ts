import { ema, crossover, crossunder } from "../indicators.js";
import type { StrategyDefinition, SignalEvent } from "./types.js";

// Mirrors strategies/ema-cross.pine — plain EMA crossover, no TP/SL bracket.
// Position only closes on the opposite crossover (or end of backtest window).
export const emaCross: StrategyDefinition = {
  id: "emaCross",
  label: "EMA Cross",
  description: "Plain EMA crossover, no take-profit/stop-loss — position flips on the opposite signal.",
  params: [
    { name: "fastLen", label: "Fast EMA", default: 20, min: 2, max: 200, step: 1 },
    { name: "slowLen", label: "Slow EMA", default: 50, min: 5, max: 400, step: 1 },
  ],
  run(candles, params) {
    const fastLen = params.fastLen ?? 20;
    const slowLen = params.slowLen ?? 50;
    const closes = candles.map((c) => c.close);
    const emaFast = ema(closes, fastLen);
    const emaSlow = ema(closes, slowLen);

    const events: SignalEvent[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (crossover(emaFast, emaSlow, i)) {
        events.push({ barIndex: i, time: candles[i]!.openTime, action: "long" });
      } else if (crossunder(emaFast, emaSlow, i)) {
        events.push({ barIndex: i, time: candles[i]!.openTime, action: "short" });
      }
    }
    return events;
  },
};
