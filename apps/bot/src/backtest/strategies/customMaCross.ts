import { ema, sma, rsi, atr, crossover, crossunder } from "../indicators.js";
import { pineForCustomMaCross } from "./pineExport.js";
import type { StrategyDefinition, SignalEvent, SignalAction } from "./types.js";

// TP/SL mode indices (kept in sync with the `tpslMode` param's `options` labels below).
const TPSL_NONE = 0;
const TPSL_ATR = 1;
const TPSL_PCT = 2;

// MA type indices (kept in sync with the `fastMaType`/`slowMaType` params' `options` labels).
const MA_EMA = 0;
const MA_SMA = 1;

// Composable EMA/SMA crossover with an optional RSI filter and a selectable TP/SL mode —
// generalizes emaCross/emaCrossTpSl/emaRsiPctTpSl into one flexible strategy (those three
// stay registered too, as named presets that match the live .pine defaults exactly).
export const customMaCross: StrategyDefinition = {
  id: "customMaCross",
  label: "Custom MA Cross",
  description: "EMA or SMA crossover, with an optional RSI filter and a choice of no bracket / ATR-multiple / percentage TP-SL.",
  params: [
    { name: "fastMaType", label: "Fast MA type", default: MA_EMA, min: 0, max: 1, step: 1, options: ["EMA", "SMA"] },
    { name: "fastLen", label: "Fast MA length", default: 20, min: 2, max: 200, step: 1 },
    { name: "slowMaType", label: "Slow MA type", default: MA_EMA, min: 0, max: 1, step: 1, options: ["EMA", "SMA"] },
    { name: "slowLen", label: "Slow MA length", default: 50, min: 5, max: 400, step: 1 },
    { name: "useRsiFilter", label: "RSI filter", default: 0, min: 0, max: 1, step: 1, options: ["Off", "On"] },
    { name: "rsiLen", label: "RSI length", default: 14, min: 2, max: 100, step: 1, showIf: { param: "useRsiFilter", equals: 1 } },
    { name: "rsiMaxForLong", label: "RSI max for long", default: 60, min: 1, max: 100, step: 1, showIf: { param: "useRsiFilter", equals: 1 } },
    { name: "rsiMinForShort", label: "RSI min for short", default: 40, min: 1, max: 100, step: 1, showIf: { param: "useRsiFilter", equals: 1 } },
    { name: "tpslMode", label: "TP/SL mode", default: TPSL_NONE, min: 0, max: 2, step: 1, options: ["None", "ATR multiple", "Percentage"] },
    { name: "atrLen", label: "ATR length", default: 14, min: 1, max: 100, step: 1, showIf: { param: "tpslMode", equals: TPSL_ATR } },
    { name: "slAtrMult", label: "SL ATR mult", default: 1.5, min: 0.1, max: 10, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_ATR } },
    { name: "tpAtrMult", label: "TP ATR mult", default: 3.0, min: 0.1, max: 10, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_ATR } },
    { name: "tpPct", label: "TP %", default: 1.5, min: 0.1, max: 50, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_PCT } },
    { name: "slPct", label: "SL %", default: 0.75, min: 0.1, max: 50, step: 0.1, showIf: { param: "tpslMode", equals: TPSL_PCT } },
  ],
  run(candles, params) {
    const fastMaType = params.fastMaType ?? MA_EMA;
    const fastLen = params.fastLen ?? 20;
    const slowMaType = params.slowMaType ?? MA_EMA;
    const slowLen = params.slowLen ?? 50;
    const useRsiFilter = (params.useRsiFilter ?? 0) === 1;
    const rsiLen = params.rsiLen ?? 14;
    const rsiMaxForLong = params.rsiMaxForLong ?? 60;
    const rsiMinForShort = params.rsiMinForShort ?? 40;
    const tpslMode = params.tpslMode ?? TPSL_NONE;
    const atrLen = params.atrLen ?? 14;
    const slAtrMult = params.slAtrMult ?? 1.5;
    const tpAtrMult = params.tpAtrMult ?? 3.0;
    const tpPct = params.tpPct ?? 1.5;
    const slPct = params.slPct ?? 0.75;

    const closes = candles.map((c) => c.close);
    const fastMA = fastMaType === MA_SMA ? sma(closes, fastLen) : ema(closes, fastLen);
    const slowMA = slowMaType === MA_SMA ? sma(closes, slowLen) : ema(closes, slowLen);
    const rsiSeries = useRsiFilter ? rsi(closes, rsiLen) : null;
    const atrSeries = tpslMode === TPSL_ATR ? atr(candles, atrLen) : null;

    const events: SignalEvent[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (useRsiFilter && rsiSeries![i] == null) continue; // RSI not warmed up yet
      if (tpslMode === TPSL_ATR && atrSeries![i] == null) continue; // ATR not warmed up yet

      const isLongCross = crossover(fastMA, slowMA, i);
      const isShortCross = crossunder(fastMA, slowMA, i);
      if (!isLongCross && !isShortCross) continue;

      if (useRsiFilter) {
        const rsiVal = rsiSeries![i]!;
        if (isLongCross && !(rsiVal < rsiMaxForLong)) continue;
        if (isShortCross && !(rsiVal > rsiMinForShort)) continue;
      }

      const action: SignalAction = isLongCross ? "long" : "short";
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
    return pineForCustomMaCross(params);
  },
};
