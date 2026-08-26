import { atr } from "../indicators.js";
import { SESSION_ANCHOR_LABELS, sessionIds } from "../sessions.js";
import type { StrategyDefinition, SignalEvent } from "./types.js";

const ONE_TRADE_OFF = 0;

/**
 * Session Opening Range Breakout.
 *
 * The one intraday setup with a mechanism behind it rather than just a curve: order flow that
 * accumulated while a region was asleep resolves when that region wakes up, and the range carved
 * out in the first minutes after the anchor is where that resolution shows its hand. Break the
 * range with conviction and the move tends to continue; poke through it and fail and it doesn't.
 *
 * Why this shape suits 5m/15m where the crossover strategies don't:
 *
 *  - It is *selective*. At most one or two trades a day, versus a crossover that fires whenever
 *    two averages touch. Round-trip cost is ~15bps of notional; the only way an intraday
 *    strategy survives that is to spend it rarely and on setups with a real directional thesis.
 *  - It is *bounded in time*. Every position gets a time stop and every session ends flat, so
 *    nothing rides into funding or into the next session's unrelated flow.
 *  - The breakout buffer filters marginal pokes, which is precisely where naive ORB bleeds out.
 *
 * `oneTradePerSession` is the other thing that matters: without it the strategy re-enters after
 * a failed break and hands back the edge on exactly the days the setup didn't work.
 */
export const sessionOrb: StrategyDefinition = {
  id: "sessionOrb",
  label: "Session ORB",
  description:
    "Opening-range breakout anchored to a UTC session open: builds a high/low range over the session's first N bars, then trades a close beyond it by an ATR buffer, with an ATR stop, an R-multiple target, a time stop, and a forced flat at session end.",
  params: [
    { name: "sessionAnchor", label: "Session anchor", default: 0, min: 0, max: SESSION_ANCHOR_LABELS.length - 1, step: 1, options: SESSION_ANCHOR_LABELS },
    { name: "rangeBars", label: "Range bars", default: 6, min: 1, max: 48, step: 1 },
    { name: "breakoutBufferAtr", label: "Breakout buffer (ATR)", default: 0.25, min: 0, max: 3, step: 0.05 },
    { name: "atrLen", label: "ATR length", default: 14, min: 1, max: 100, step: 1 },
    { name: "slAtrMult", label: "SL ATR mult", default: 1.5, min: 0.1, max: 10, step: 0.1 },
    { name: "tpRMultiple", label: "TP (R multiple)", default: 2.0, min: 0.2, max: 10, step: 0.1 },
    { name: "maxBarsHeld", label: "Time stop (bars)", default: 24, min: 2, max: 300, step: 1 },
    { name: "oneTradePerSession", label: "One trade per session", default: 1, min: 0, max: 1, step: 1, options: ["Off", "On"] },
  ],
  run(candles, params) {
    const anchor = params.sessionAnchor ?? 0;
    const rangeBars = Math.max(1, Math.round(params.rangeBars ?? 6));
    const breakoutBufferAtr = params.breakoutBufferAtr ?? 0.25;
    const atrLen = params.atrLen ?? 14;
    const slAtrMult = params.slAtrMult ?? 1.5;
    const tpRMultiple = params.tpRMultiple ?? 2.0;
    const maxBarsHeld = Math.max(1, Math.round(params.maxBarsHeld ?? 24));
    const oneTradePerSession = (params.oneTradePerSession ?? 1) === 1;

    const ids = sessionIds(candles, anchor);
    const atrSeries = atr(candles, atrLen);
    const events: SignalEvent[] = [];

    // Rolling per-session state. Reset on the first bar of each session rather than precomputing
    // per-session slices, so a session that is partially missing from the candle history (a data
    // gap, or the very first/last session in the window) degrades gracefully instead of throwing.
    let barsIntoSession = 0;
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    let tradedThisSession = false;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i]!;

      if (i === 0 || ids[i] !== ids[i - 1]) {
        barsIntoSession = 0;
        rangeHigh = -Infinity;
        rangeLow = Infinity;
        tradedThisSession = false;
      }

      // Whether this bar closes out its session is calendar knowledge, not price lookahead — the
      // session boundary is known in advance, so reading ids[i + 1] here is legitimate.
      const isLastBarOfSession = i === candles.length - 1 || ids[i + 1] !== ids[i];
      if (isLastBarOfSession) {
        // Nothing carries across a session boundary, into funding, or into the next region's
        // unrelated flow. Emitted unconditionally — the engine no-ops a flat with nothing open,
        // since the strategy has no view of position state (see SignalAction's "flat" docs).
        // Emitting this *instead of* an entry also stops the strategy opening a position on the
        // very bar it would immediately have to close.
        events.push({ barIndex: i, time: bar.openTime, action: "flat" });
        continue;
      }

      barsIntoSession++;

      if (barsIntoSession <= rangeBars) {
        // Still defining the opening range — accumulate, never trade.
        if (bar.high > rangeHigh) rangeHigh = bar.high;
        if (bar.low < rangeLow) rangeLow = bar.low;
        continue;
      }

      if (tradedThisSession && oneTradePerSession) continue;
      if (rangeHigh === -Infinity || rangeLow === Infinity) continue; // session began mid-history, no range was built

      const atrVal = atrSeries[i];
      if (atrVal == null || atrVal <= 0) continue; // ATR not warmed up — buffer and bracket would both be meaningless

      const buffer = atrVal * breakoutBufferAtr;
      const brokeUp = bar.close > rangeHigh + buffer;
      const brokeDown = bar.close < rangeLow - buffer;
      if (!brokeUp && !brokeDown) continue;

      events.push({
        barIndex: i,
        time: bar.openTime,
        action: brokeUp ? "long" : "short",
        slAtrMult,
        // TP expressed as a multiple of the stop distance keeps R:R an explicit, searchable
        // param instead of an emergent ratio of two independently-tuned ATR multiples.
        tpAtrMult: slAtrMult * tpRMultiple,
        atrAtSignal: atrVal,
        maxBarsHeld,
      });
      tradedThisSession = true;
    }

    return events;
  },
};
