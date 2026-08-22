import { describe, it, expect } from "vitest";
import { customMaCross } from "./customMaCross.js";
import { ema, sma, atr, crossover, crossunder } from "../indicators.js";
import type { Candle } from "../types.js";

// Declining-then-recovering price series so fast/slow MAs cross both ways within a small window.
const closes = [100, 90, 80, 70, 60, 70, 80, 90, 100, 110, 120, 110, 100, 90, 80];
const candles: Candle[] = closes.map((close, i) => ({
  openTime: i,
  open: close,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1,
}));

function expectedCrossBars(fastLen: number, slowLen: number): { longBars: number[]; shortBars: number[] } {
  const fast = ema(closes, fastLen);
  const slow = ema(closes, slowLen);
  const longBars: number[] = [];
  const shortBars: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (crossover(fast, slow, i)) longBars.push(i);
    if (crossunder(fast, slow, i)) shortBars.push(i);
  }
  return { longBars, shortBars };
}

describe("customMaCross", () => {
  it("emits long/short events at EMA/EMA crossover bars with no bracket by default", () => {
    const { longBars, shortBars } = expectedCrossBars(2, 3);
    const events = customMaCross.run(candles, { fastMaType: 0, fastLen: 2, slowMaType: 0, slowLen: 3, useRsiFilter: 0, tpslMode: 0 });

    expect(events.map((e) => e.barIndex)).toEqual([...longBars, ...shortBars].sort((a, b) => a - b));
    for (const e of events) {
      expect(e.tpPct).toBeUndefined();
      expect(e.slPct).toBeUndefined();
      expect(e.tpAtrMult).toBeUndefined();
    }
  });

  it("uses SMA instead of EMA when the MA type param selects it", () => {
    const fastSma = sma(closes, 2);
    const slowSma = sma(closes, 3);
    const expectedLongBars: number[] = [];
    for (let i = 0; i < closes.length; i++) if (crossover(fastSma, slowSma, i)) expectedLongBars.push(i);

    const events = customMaCross.run(candles, { fastMaType: 1, fastLen: 2, slowMaType: 1, slowLen: 3, useRsiFilter: 0, tpslMode: 0 });

    expect(events.filter((e) => e.action === "long").map((e) => e.barIndex)).toEqual(expectedLongBars);
  });

  it("filters out crossovers that fail the RSI condition", () => {
    const withoutFilter = customMaCross.run(candles, { fastMaType: 0, fastLen: 2, slowMaType: 0, slowLen: 3, useRsiFilter: 0, tpslMode: 0 });
    // rsiMaxForLong: 1 is an impossible bar for RSI to clear (RSI is always >= 0, but "< 1" is
    // an extremely tight gate) — used here to force every long crossover to be filtered out.
    const withFilter = customMaCross.run(candles, {
      fastMaType: 0, fastLen: 2, slowMaType: 0, slowLen: 3, useRsiFilter: 1, rsiLen: 3, rsiMaxForLong: 1, rsiMinForShort: 40, tpslMode: 0,
    });

    expect(withoutFilter.some((e) => e.action === "long")).toBe(true);
    expect(withFilter.some((e) => e.action === "long")).toBe(false);
  });

  it("attaches an ATR-multiple bracket anchored to the signal-bar ATR when tpslMode is ATR", () => {
    const atrSeries = atr(candles, 3);
    const events = customMaCross.run(candles, {
      fastMaType: 0, fastLen: 2, slowMaType: 0, slowLen: 3, useRsiFilter: 0, tpslMode: 1, atrLen: 3, slAtrMult: 1.5, tpAtrMult: 3,
    });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.tpAtrMult).toBe(3);
      expect(e.slAtrMult).toBe(1.5);
      expect(e.atrAtSignal).toBe(atrSeries[e.barIndex]);
    }
  });

  it("attaches a percentage bracket when tpslMode is Percentage", () => {
    const events = customMaCross.run(candles, {
      fastMaType: 0, fastLen: 2, slowMaType: 0, slowLen: 3, useRsiFilter: 0, tpslMode: 2, tpPct: 2.5, slPct: 1.25,
    });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.tpPct).toBe(2.5);
      expect(e.slPct).toBe(1.25);
      expect(e.tpAtrMult).toBeUndefined();
    }
  });

  it("exposes Pine export support and generates parseable-looking Pine text for each TP/SL mode", () => {
    expect(typeof customMaCross.toPine).toBe("function");
    for (const tpslMode of [0, 1, 2]) {
      const pine = customMaCross.toPine!({ fastMaType: 0, fastLen: 20, slowMaType: 1, slowLen: 50, useRsiFilter: 1, rsiLen: 14, tpslMode });
      expect(pine).toContain("@version=6");
      expect(pine).toContain("strategy(");
      expect(pine).toContain("ta.ema(close, fastLen)");
      expect(pine).toContain("ta.sma(close, slowLen)");
      expect(pine).toContain("ta.rsi(close, rsiLen)");
      expect(pine).toContain("alert.freq_once_per_bar_close");
    }
  });
});
