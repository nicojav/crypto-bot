import { describe, it, expect } from "vitest";
import { buildRegimeGate, REGIME_OFF, REGIME_RANGING, REGIME_TRENDING, REGIME_VOLATILE } from "./regimeFilter.js";
import type { Candle } from "../types.js";

function bar(openTime: number, high: number, low: number, close: number): Candle {
  return { openTime, open: close, high, low, close, volume: 1 };
}

const HOUR = 3_600_000;
const START = Date.parse("2026-03-02T00:00:00Z");

/** A clean one-directional trend — high ADX. */
function trendingCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => bar(START + i * HOUR, 100 + i * 2 + 1, 100 + i * 2 - 1, 100 + i * 2));
}

/** Alternating up/down bars — low ADX. */
function chopCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? bar(START + i * HOUR, 102, 98, 100) : bar(START + i * HOUR, 101, 97, 99),
  );
}

describe("buildRegimeGate", () => {
  it("allows every bar when the mode is Off", () => {
    const candles = chopCandles(10);
    const gate = buildRegimeGate(candles, { regimeMode: REGIME_OFF });
    expect(candles.every((_, i) => gate(i))).toBe(true);
  });

  it("Trending mode allows a strong trend and rejects chop", () => {
    const trend = trendingCandles(60);
    const chop = chopCandles(80);
    const params = { regimeMode: REGIME_TRENDING, regimeLen: 14, regimeThreshold: 25 };

    expect(buildRegimeGate(trend, params)(59)).toBe(true);
    expect(buildRegimeGate(chop, params)(79)).toBe(false);
  });

  it("Ranging mode is the mirror image of Trending", () => {
    const trend = trendingCandles(60);
    const chop = chopCandles(80);
    const params = { regimeMode: REGIME_RANGING, regimeLen: 14, regimeThreshold: 25 };

    expect(buildRegimeGate(trend, params)(59)).toBe(false);
    expect(buildRegimeGate(chop, params)(79)).toBe(true);
  });

  it("rejects bars before the gating indicator has warmed up, rather than allowing them", () => {
    // An ungated bar during warmup is exactly the failure mode a regime filter exists to prevent.
    const candles = trendingCandles(60);
    const gate = buildRegimeGate(candles, { regimeMode: REGIME_TRENDING, regimeLen: 14, regimeThreshold: 25 });
    expect(gate(0)).toBe(false);
  });

  it("Volatile mode gates on ATR's own percentile, not an absolute level", () => {
    // A calm stretch followed by a genuinely wide-range stretch — percentile should separate them
    // regardless of the underlying price scale.
    const calm = Array.from({ length: 40 }, (_, i) => bar(START + i * HOUR, 100.5, 99.5, 100));
    const wide = Array.from({ length: 20 }, (_, i) => bar(START + (40 + i) * HOUR, 110, 90, 100));
    const candles = [...calm, ...wide];
    const params = { regimeMode: REGIME_VOLATILE, regimeLen: 5, regimeThreshold: 80 };
    const gate = buildRegimeGate(candles, params);

    expect(gate(candles.length - 1)).toBe(true); // inside the wide stretch
    expect(gate(20)).toBe(false); // inside the calm stretch
  });

  it("combines with the session filter as an AND, not an OR", () => {
    // Trending AND inside the session window — dropping either half should reject.
    const candles = trendingCandles(60);
    const insideHour = new Date(candles[59]!.openTime).getUTCHours();
    const outsideHour = (insideHour + 12) % 24;

    const inWindow = buildRegimeGate(candles, {
      regimeMode: REGIME_TRENDING, regimeLen: 14, regimeThreshold: 25,
      useSessionFilter: 1, sessionStartHourUtc: insideHour, sessionEndHourUtc: (insideHour + 1) % 24,
    });
    const outOfWindow = buildRegimeGate(candles, {
      regimeMode: REGIME_TRENDING, regimeLen: 14, regimeThreshold: 25,
      useSessionFilter: 1, sessionStartHourUtc: outsideHour, sessionEndHourUtc: (outsideHour + 1) % 24,
    });

    expect(inWindow(59)).toBe(true);
    expect(outOfWindow(59)).toBe(false);
  });

  it("applies the session filter alone when regime mode is Off", () => {
    const candles = chopCandles(10);
    const hour = new Date(candles[5]!.openTime).getUTCHours();
    const gate = buildRegimeGate(candles, {
      regimeMode: REGIME_OFF, useSessionFilter: 1, sessionStartHourUtc: hour, sessionEndHourUtc: (hour + 1) % 24,
    });

    expect(gate(5)).toBe(true);
  });
});
