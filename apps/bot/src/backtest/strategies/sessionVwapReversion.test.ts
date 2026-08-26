import { describe, it, expect } from "vitest";
import { sessionVwapReversion } from "./sessionVwapReversion.js";
import type { Candle } from "../types.js";

const FIVE_MIN = 5 * 60_000;
const DAY_START = Date.parse("2026-03-02T00:00:00Z");

function series(start: number, rows: [number, number, number][]): Candle[] {
  return rows.map(([high, low, close], i) => ({
    openTime: start + i * FIVE_MIN,
    open: close,
    high,
    low,
    close,
    volume: 100,
  }));
}

const flat: [number, number, number] = [100.5, 99.5, 100];

const baseParams = {
  sessionAnchor: 0,
  bandMult: 1.5,
  adxLen: 5,
  adxMax: 100, // effectively "always ranging" — the gate is exercised separately below
  atrLen: 3,
  slAtrMult: 1.5,
  minBarsIntoSession: 3,
  maxBarsHeld: 12,
};

const entries = (events: { action: string }[]) => events.filter((e) => e.action !== "flat");

/** Index of the deliberately-stretched bar inside a `stretchedSession` run. */
const STRETCH_BAR = 12;

/**
 * Chop around 100 to establish a VWAP and a non-zero sigma, then one stretched bar at
 * STRETCH_BAR. Note the chop itself produces some entries: early in a session sigma is tiny, so
 * ordinary bars clear a 1.5-sigma band easily. Tests therefore assert on the stretch bar by index
 * rather than on the first entry in the list.
 */
function stretchedSession(stretch: [number, number, number]): Candle[] {
  const chop: [number, number, number][] = [
    [101, 99, 101], [101, 99, 99], [101, 99, 101], [101, 99, 99],
    [101, 99, 101], [101, 99, 99], [101, 99, 101], [101, 99, 99],
    [101, 99, 101], [101, 99, 99], [101, 99, 101], [101, 99, 99],
  ];
  return series(DAY_START, [...chop, stretch, flat]);
}

describe("sessionVwapReversion", () => {
  it("goes long on a stretch below the lower band", () => {
    const events = sessionVwapReversion.run(stretchedSession([90, 80, 80]), baseParams);
    const atStretch = events.find((e) => e.barIndex === STRETCH_BAR);

    expect(atStretch).toBeDefined();
    expect(atStretch!.action).toBe("long");
  });

  it("goes short on a stretch above the upper band", () => {
    const events = sessionVwapReversion.run(stretchedSession([130, 118, 120]), baseParams);
    const atStretch = events.find((e) => e.barIndex === STRETCH_BAR);

    expect(atStretch).toBeDefined();
    expect(atStretch!.action).toBe("short");
  });

  it("emits a stop with no take-profit, since the target is VWAP itself", () => {
    const events = sessionVwapReversion.run(stretchedSession([90, 80, 80]), baseParams);
    const signal = events.find((e) => e.barIndex === STRETCH_BAR);

    expect(signal!.slAtrMult).toBe(1.5);
    expect(signal!.atrAtSignal).toBeGreaterThan(0);
    expect(signal!.tpAtrMult).toBeUndefined();
    expect(signal!.tpPct).toBeUndefined();
    expect(signal!.maxBarsHeld).toBe(12);
  });

  it("refuses to fade while ADX says the market is trending", () => {
    // A clean one-directional ramp: ADX is high, so a mean-reversion entry must be suppressed.
    // This is the exact failure mode bbMeanReversion has — fading into an impulse.
    const rows: [number, number, number][] = Array.from(
      { length: 60 },
      (_, i) => [100 + i * 3 + 1, 100 + i * 3 - 1, 100 + i * 3] as [number, number, number],
    );
    const candles = series(DAY_START, rows);

    const gated = entries(sessionVwapReversion.run(candles, { ...baseParams, adxMax: 20 }));
    const ungated = entries(sessionVwapReversion.run(candles, { ...baseParams, adxMax: 100 }));

    expect(gated).toHaveLength(0);
    expect(ungated.length).toBeGreaterThan(0);
  });

  it("skips the start of a session where VWAP sigma is still meaningless", () => {
    // With only a couple of bars accumulated, every bar looks like a multi-sigma stretch.
    const candles = stretchedSession([90, 80, 80]);
    const events = entries(sessionVwapReversion.run(candles, { ...baseParams, minBarsIntoSession: 0 }));
    const guarded = entries(sessionVwapReversion.run(candles, { ...baseParams, minBarsIntoSession: 8 }));

    expect(guarded.every((e) => e.barIndex >= 8)).toBe(true);
    expect(guarded.length).toBeLessThanOrEqual(events.length);
  });

  it("emits a flat when price crosses back through VWAP", () => {
    // Stretch far below, then snap back above the running VWAP — that crossback is the exit.
    const candles = stretchedSession([90, 80, 80]);
    const withSnapback = [
      ...candles,
      ...series(DAY_START + candles.length * FIVE_MIN, [[140, 118, 135]]),
    ];

    const events = sessionVwapReversion.run(withSnapback, baseParams);
    const flatBars = events.filter((e) => e.action === "flat").map((e) => e.barIndex);

    expect(flatBars).toContain(withSnapback.length - 1);
  });

  it("flattens on the last bar of each session", () => {
    const day1 = stretchedSession([90, 80, 80]);
    const day2 = series(DAY_START + 24 * 3_600_000, [flat, flat, flat, flat]);
    const events = sessionVwapReversion.run([...day1, ...day2], baseParams);
    const flatBars = events.filter((e) => e.action === "flat").map((e) => e.barIndex);

    expect(flatBars).toContain(day1.length - 1);
    expect(flatBars).toContain(day1.length + day2.length - 1);
  });

  it("emits at most one signal per bar index", () => {
    // The engine keys signals into a Map by barIndex — a duplicate would silently drop one, and
    // this strategy emits entries and flats from the same loop.
    const events = sessionVwapReversion.run(stretchedSession([90, 80, 80]), baseParams);
    const indices = events.map((e) => e.barIndex);

    expect(new Set(indices).size).toBe(indices.length);
  });

  it("produces no entries on a perfectly flat session", () => {
    const candles = series(DAY_START, Array.from({ length: 30 }, () => flat));
    expect(entries(sessionVwapReversion.run(candles, baseParams))).toHaveLength(0);
  });

  it("handles an empty candle array", () => {
    expect(sessionVwapReversion.run([], baseParams)).toEqual([]);
  });
});
