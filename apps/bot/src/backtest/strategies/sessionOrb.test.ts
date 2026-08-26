import { describe, it, expect } from "vitest";
import { sessionOrb } from "./sessionOrb.js";
import type { Candle } from "../types.js";

const FIVE_MIN = 5 * 60_000;
const DAY_START = Date.parse("2026-03-02T00:00:00Z");

/** Builds a run of 5m candles starting at `start`, from [high, low, close] triples. */
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

/** A quiet bar that neither extends the range nor triggers anything. */
const quiet: [number, number, number] = [101, 99, 100];

const baseParams = {
  sessionAnchor: 0,
  rangeBars: 3,
  breakoutBufferAtr: 0,
  atrLen: 2,
  slAtrMult: 1.5,
  tpRMultiple: 2,
  maxBarsHeld: 24,
  oneTradePerSession: 1,
};

const entries = (events: { action: string }[]) => events.filter((e) => e.action !== "flat");

describe("sessionOrb", () => {
  it("does not trade during the opening range, then breaks out above it", () => {
    const candles = series(DAY_START, [quiet, quiet, quiet, quiet, [120, 99, 118], quiet]);
    const events = sessionOrb.run(candles, baseParams);

    const longs = entries(events);
    expect(longs).toHaveLength(1);
    expect(longs[0]).toMatchObject({ action: "long", barIndex: 4 });
    // Nothing may fire on bars 0..2 — those bars define the range.
    expect(longs.every((e) => e.barIndex >= 3)).toBe(true);
  });

  it("goes short on a break below the opening range", () => {
    const candles = series(DAY_START, [quiet, quiet, quiet, quiet, [101, 80, 82], quiet]);
    const events = sessionOrb.run(candles, baseParams);

    expect(entries(events)).toHaveLength(1);
    expect(entries(events)[0]).toMatchObject({ action: "short", barIndex: 4 });
  });

  it("emits an R-multiple target derived from the stop distance", () => {
    const candles = series(DAY_START, [quiet, quiet, quiet, quiet, [120, 99, 118], quiet]);
    const [signal] = entries(sessionOrb.run(candles, baseParams));

    expect(signal!.slAtrMult).toBe(1.5);
    expect(signal!.tpAtrMult).toBe(3); // 1.5 * tpRMultiple 2
    expect(signal!.atrAtSignal).toBeGreaterThan(0);
    expect(signal!.maxBarsHeld).toBe(24);
  });

  it("takes only the first breakout per session when oneTradePerSession is on", () => {
    const candles = series(DAY_START, [quiet, quiet, quiet, [120, 99, 118], [130, 99, 128], [140, 99, 138]]);

    const once = entries(sessionOrb.run(candles, baseParams));
    expect(once).toHaveLength(1);

    // Re-entering after the first break is exactly how ORB gives back its edge, so the toggle has
    // to actually change behaviour.
    const repeated = entries(sessionOrb.run(candles, { ...baseParams, oneTradePerSession: 0 }));
    expect(repeated.length).toBeGreaterThan(1);
  });

  it("suppresses marginal pokes through the range when a buffer is set", () => {
    // Closes just 0.5 above the range high — real enough to trigger with no buffer, noise with one.
    const candles = series(DAY_START, [quiet, quiet, quiet, quiet, [101.6, 99, 101.5], quiet]);

    expect(entries(sessionOrb.run(candles, baseParams))).toHaveLength(1);
    expect(entries(sessionOrb.run(candles, { ...baseParams, breakoutBufferAtr: 2 }))).toHaveLength(0);
  });

  it("flattens on the last bar of every session and never carries across the boundary", () => {
    const day1 = series(DAY_START, [quiet, quiet, quiet, quiet, [120, 99, 118]]);
    const day2 = series(DAY_START + 24 * 3_600_000, [quiet, quiet, quiet, quiet, quiet]);
    const candles = [...day1, ...day2];

    const events = sessionOrb.run(candles, baseParams);
    const flats = events.filter((e) => e.action === "flat").map((e) => e.barIndex);

    expect(flats).toContain(day1.length - 1); // final bar of day 1
    expect(flats).toContain(candles.length - 1); // final bar of the window
  });

  it("starts a fresh range each session rather than carrying the previous one", () => {
    // Day 1 ranges high (up to 200); day 2 is quiet around 100. If the range carried over, day 2's
    // break above ~101 could never trigger.
    const day1 = series(DAY_START, [[200, 99, 150], [200, 99, 150], [200, 99, 150], quiet, quiet]);
    const day2 = series(DAY_START + 24 * 3_600_000, [quiet, quiet, quiet, [120, 99, 118], quiet]);
    const events = sessionOrb.run([...day1, ...day2], baseParams);

    const day2Entries = entries(events).filter((e) => e.barIndex >= day1.length);
    expect(day2Entries).toHaveLength(1);
    expect(day2Entries[0]!.action).toBe("long");
  });

  it("never emits an entry on a bar it would immediately have to flatten", () => {
    const candles = series(DAY_START, [quiet, quiet, quiet, quiet, [120, 99, 118]]);
    const events = sessionOrb.run(candles, baseParams);

    const lastBar = candles.length - 1;
    const onLastBar = events.filter((e) => e.barIndex === lastBar);
    expect(onLastBar).toHaveLength(1);
    expect(onLastBar[0]!.action).toBe("flat");
  });

  it("produces no entries when price never leaves the opening range", () => {
    const candles = series(DAY_START, Array.from({ length: 12 }, () => quiet));
    expect(entries(sessionOrb.run(candles, baseParams))).toHaveLength(0);
  });

  it("handles an empty candle array", () => {
    expect(sessionOrb.run([], baseParams)).toEqual([]);
  });

  it("emits at most one signal per bar index", () => {
    // The engine keys signals into a Map by barIndex, so a duplicate would silently drop one.
    const day1 = series(DAY_START, [quiet, quiet, quiet, [120, 99, 118], quiet]);
    const day2 = series(DAY_START + 24 * 3_600_000, [quiet, quiet, quiet, [130, 99, 128], quiet]);
    const events = sessionOrb.run([...day1, ...day2], baseParams);

    const indices = events.map((e) => e.barIndex);
    expect(new Set(indices).size).toBe(indices.length);
  });
});
