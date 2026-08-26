import { adx, atr, sessionVwap } from "../indicators.js";
import { SESSION_ANCHOR_LABELS, sessionIds } from "../sessions.js";
import type { StrategyDefinition, SignalEvent } from "./types.js";

/**
 * Session VWAP Reversion — mean reversion that knows when *not* to fade.
 *
 * This is bbMeanReversion's idea done properly, and the three differences are the whole point:
 *
 *  1. **Anchored, not rolling.** A rolling SMA is a level nobody is looking at. The session VWAP
 *     is the level a large share of intraday participants actually benchmark execution against,
 *     which is *why* price reverts to it — the reversion has a constituency.
 *  2. **Volume-weighted.** Both the mean and the band width weight by volume, so a stretch on
 *     thin overnight tape doesn't register as the same event as one on real participation.
 *  3. **Regime-gated.** bbMeanReversion fades every band breach, including breaches during a
 *     trending impulse — which is exactly when fading is most lethal. Here the ADX ceiling means
 *     the strategy only fades while the market is genuinely ranging, and sits out trends.
 *
 * The exit is the other reason this needs the newer engine. The natural target is VWAP itself,
 * which *moves* — a static TP price set at fill time cannot express it. So entries carry only a
 * stop, and the strategy emits a "flat" on any bar where price crosses back through VWAP. Having
 * no view of its own position state, it emits those unconditionally and lets the engine no-op the
 * ones where nothing is open.
 */
export const sessionVwapReversion: StrategyDefinition = {
  id: "sessionVwapReversion",
  label: "Session VWAP Reversion",
  description:
    "Fades stretches beyond session-anchored VWAP sigma bands, but only while ADX says the market is ranging. Exits back at VWAP via a flat signal, with an ATR stop, a time stop, and a forced flat at session end.",
  params: [
    { name: "sessionAnchor", label: "Session anchor", default: 0, min: 0, max: SESSION_ANCHOR_LABELS.length - 1, step: 1, options: SESSION_ANCHOR_LABELS },
    { name: "bandMult", label: "Band sigma mult", default: 2.0, min: 0.5, max: 5, step: 0.1 },
    { name: "adxLen", label: "ADX length", default: 14, min: 2, max: 100, step: 1 },
    { name: "adxMax", label: "ADX max (ranging)", default: 25, min: 5, max: 60, step: 1 },
    { name: "atrLen", label: "ATR length", default: 14, min: 1, max: 100, step: 1 },
    { name: "slAtrMult", label: "SL ATR mult", default: 1.5, min: 0.1, max: 10, step: 0.1 },
    { name: "minBarsIntoSession", label: "Min bars into session", default: 3, min: 0, max: 48, step: 1 },
    { name: "maxBarsHeld", label: "Time stop (bars)", default: 12, min: 2, max: 300, step: 1 },
  ],
  run(candles, params) {
    const anchor = params.sessionAnchor ?? 0;
    const bandMult = params.bandMult ?? 2.0;
    const adxLen = params.adxLen ?? 14;
    const adxMax = params.adxMax ?? 25;
    const atrLen = params.atrLen ?? 14;
    const slAtrMult = params.slAtrMult ?? 1.5;
    const minBarsIntoSession = Math.max(0, Math.round(params.minBarsIntoSession ?? 3));
    const maxBarsHeld = Math.max(1, Math.round(params.maxBarsHeld ?? 12));

    const ids = sessionIds(candles, anchor);
    const { vwap, sigma } = sessionVwap(candles, ids);
    const adxSeries = adx(candles, adxLen);
    const atrSeries = atr(candles, atrLen);

    const events: SignalEvent[] = [];
    let barsIntoSession = 0;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i]!;

      if (i === 0 || ids[i] !== ids[i - 1]) barsIntoSession = 0;
      barsIntoSession++;

      // Session boundaries are calendar knowledge, known in advance — not price lookahead.
      const isLastBarOfSession = i === candles.length - 1 || ids[i + 1] !== ids[i];
      if (isLastBarOfSession) {
        events.push({ barIndex: i, time: bar.openTime, action: "flat" });
        continue;
      }

      const vwapVal = vwap[i];
      const sigmaVal = sigma[i];
      if (vwapVal == null || sigmaVal == null || sigmaVal <= 0) continue;

      // Early in a session the VWAP is an average of two or three bars and its sigma is
      // essentially noise, so every bar looks like a multi-sigma stretch. Skip until the anchor
      // has accumulated enough participation to mean something.
      if (barsIntoSession <= minBarsIntoSession) continue;

      const upper = vwapVal + sigmaVal * bandMult;
      const lower = vwapVal - sigmaVal * bandMult;
      const stretchedBelow = bar.close < lower;
      const stretchedAbove = bar.close > upper;
      const isStretched = stretchedBelow || stretchedAbove;

      // Exit: price has come back through VWAP *and* is no longer at an extreme.
      //
      // The "no longer at an extreme" half is essential. A bar that rips from below VWAP to well
      // above it technically crosses VWAP, but it is a fresh stretch — a setup, not a target
      // reached. Testing the crossing alone treats every such bar as an exit and swallows the
      // entry that should have fired on it, which silently removes one whole side of the strategy.
      if (!isStretched && i > 0) {
        const prevVwap = vwap[i - 1];
        if (prevVwap != null) {
          const prevClose = candles[i - 1]!.close;
          const crossedUp = prevClose <= prevVwap && bar.close > vwapVal;
          const crossedDown = prevClose >= prevVwap && bar.close < vwapVal;
          if (crossedUp || crossedDown) {
            events.push({ barIndex: i, time: bar.openTime, action: "flat" });
          }
        }
        continue;
      }

      if (!isStretched) continue;

      const adxVal = adxSeries[i];
      if (adxVal == null || adxVal > adxMax) continue; // trending (or still warming up) — do not fade

      const atrVal = atrSeries[i];
      if (atrVal == null || atrVal <= 0) continue;

      events.push({
        barIndex: i,
        time: bar.openTime,
        action: stretchedBelow ? "long" : "short",
        // Stop only — the target is VWAP, which moves, and is handled by the flat signal above.
        slAtrMult,
        atrAtSignal: atrVal,
        maxBarsHeld,
      });
    }

    return events;
  },
};
