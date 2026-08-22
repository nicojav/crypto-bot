import { describe, it, expect } from "vitest";
import { bbMeanReversion } from "./bbMeanReversion.js";
import { sma, stddev, atr, crossover, crossunder } from "../indicators.js";
import type { Candle } from "../types.js";

// Flat baseline with two sharp spikes (down then up) so price breaches the bands both ways.
const closes = [100, 100, 100, 100, 100, 80, 100, 100, 100, 100, 120, 100, 100, 100, 100];
const candles: Candle[] = closes.map((close, i) => ({
  openTime: i,
  open: close,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1,
}));

function expectedBandTriggers(bbLen: number, bbMult: number): { longBars: number[]; shortBars: number[] } {
  const basis = sma(closes, bbLen);
  const dev = stddev(closes, bbLen);
  const upper = basis.map((b, i) => (b == null || dev[i] == null ? null : b + dev[i]! * bbMult));
  const lower = basis.map((b, i) => (b == null || dev[i] == null ? null : b - dev[i]! * bbMult));
  const longBars: number[] = [];
  const shortBars: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (crossunder(closes, lower, i)) longBars.push(i);
    if (crossover(closes, upper, i)) shortBars.push(i);
  }
  return { longBars, shortBars };
}

describe("bbMeanReversion", () => {
  it("emits long on a lower-band breach and short on an upper-band breach, with no bracket by default", () => {
    const { longBars, shortBars } = expectedBandTriggers(5, 1);
    const events = bbMeanReversion.run(candles, { bbLen: 5, bbMult: 1, useRsiConfirm: 0, tpslMode: 0 });

    expect(events.map((e) => e.barIndex)).toEqual([...longBars, ...shortBars].sort((a, b) => a - b));
    expect(events.some((e) => e.action === "long")).toBe(true);
    expect(events.some((e) => e.action === "short")).toBe(true);
    for (const e of events) {
      expect(e.tpPct).toBeUndefined();
      expect(e.tpAtrMult).toBeUndefined();
    }
  });

  it("filters out band breaches that fail the RSI oversold/overbought confirmation", () => {
    const withoutConfirm = bbMeanReversion.run(candles, { bbLen: 5, bbMult: 1, useRsiConfirm: 0, tpslMode: 0 });
    // rsiOversold: 1 is an impossible bar for RSI to clear — forces every long trigger to be filtered out.
    const withConfirm = bbMeanReversion.run(candles, {
      bbLen: 5, bbMult: 1, useRsiConfirm: 1, rsiLen: 3, rsiOversold: 0, rsiOverbought: 70, tpslMode: 0,
    });

    expect(withoutConfirm.some((e) => e.action === "long")).toBe(true);
    expect(withConfirm.some((e) => e.action === "long")).toBe(false);
  });

  it("attaches an ATR-multiple bracket anchored to the signal-bar ATR when tpslMode is ATR", () => {
    const atrSeries = atr(candles, 3);
    const events = bbMeanReversion.run(candles, {
      bbLen: 5, bbMult: 1, useRsiConfirm: 0, tpslMode: 1, atrLen: 3, slAtrMult: 1.5, tpAtrMult: 3,
    });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.tpAtrMult).toBe(3);
      expect(e.slAtrMult).toBe(1.5);
      expect(e.atrAtSignal).toBe(atrSeries[e.barIndex]);
    }
  });

  it("attaches a percentage bracket when tpslMode is Percentage", () => {
    const events = bbMeanReversion.run(candles, {
      bbLen: 5, bbMult: 1, useRsiConfirm: 0, tpslMode: 2, tpPct: 1, slPct: 0.5,
    });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.tpPct).toBe(1);
      expect(e.slPct).toBe(0.5);
      expect(e.tpAtrMult).toBeUndefined();
    }
  });

  it("exposes Pine export support and generates parseable-looking Pine text for each TP/SL mode", () => {
    expect(typeof bbMeanReversion.toPine).toBe("function");
    for (const tpslMode of [0, 1, 2]) {
      const pine = bbMeanReversion.toPine!({ bbLen: 20, bbMult: 1, useRsiConfirm: 1, rsiLen: 14, tpslMode });
      expect(pine).toContain("@version=6");
      expect(pine).toContain("strategy(");
      expect(pine).toContain("ta.sma(close, bbLen)");
      expect(pine).toContain("ta.stdev(close, bbLen)");
      expect(pine).toContain("ta.rsi(close, rsiLen)");
      expect(pine).toContain("ta.crossunder(close, lowerBand)");
      expect(pine).toContain("alert.freq_once_per_bar_close");
    }
  });
});
