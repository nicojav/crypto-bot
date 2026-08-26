import { describe, it, expect } from "vitest";
import { adx, donchian, ema, sma, sessionVwap, stddev, rma, rollingPercentile, rsi, atr, crossover, crossunder } from "./indicators.js";
import type { Candle } from "./types.js";

describe("stddev", () => {
  it("computes the rolling population standard deviation", () => {
    // Window [2,4,4,4,5,5,7,9] has population stddev = 2 (textbook example).
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const out = stddev(values, 8);
    expect(out[7]).toBeCloseTo(2, 10);
  });

  it("is null until the window is fully populated", () => {
    const out = stddev([1, 2, 3], 5);
    expect(out).toEqual([null, null, null]);
  });

  it("is 0 for a constant series", () => {
    const out = stddev([5, 5, 5, 5], 3);
    expect(out[2]).toBeCloseTo(0, 10);
    expect(out[3]).toBeCloseTo(0, 10);
  });
});

describe("sma", () => {
  it("is null until the window is fully populated, then is the rolling mean", () => {
    const values = [1, 2, 3, 4, 5, 6];
    const out = sma(values, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo((1 + 2 + 3) / 3, 10);
    expect(out[3]).toBeCloseTo((2 + 3 + 4) / 3, 10);
    expect(out[5]).toBeCloseTo((4 + 5 + 6) / 3, 10);
  });

  it("returns all-null when there isn't enough data for the window", () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe("ema", () => {
  it("seeds with the first value, then applies alpha = 2/(length+1)", () => {
    const values = [10, 20, 30, 40, 50];
    const out = ema(values, 4);
    const alpha = 2 / 5;
    expect(out[0]).toBe(10);
    expect(out[1]).toBeCloseTo(alpha * 20 + (1 - alpha) * 10, 10);
    expect(out[2]).toBeCloseTo(alpha * 30 + (1 - alpha) * out[1]!, 10);
    expect(out.length).toBe(values.length);
  });
});

describe("rma", () => {
  it("is null until the SMA seed at index length-1, then smooths recursively", () => {
    const values = [1, 2, 3, 4, 5, 6];
    const out = rma(values, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo((1 + 2 + 3) / 3, 10); // SMA seed
    const alpha = 1 / 3;
    expect(out[3]).toBeCloseTo(alpha * 4 + (1 - alpha) * out[2]!, 10);
  });

  it("returns all-null when there isn't enough data for the seed", () => {
    const out = rma([1, 2], 5);
    expect(out).toEqual([null, null]);
  });
});

describe("rsi", () => {
  it("is 100 when every change is a gain and average loss is 0", () => {
    const closes = [1, 2, 3, 4, 5, 6, 7];
    const out = rsi(closes, 3);
    // warmup: change[0] doesn't exist, seed needs 3 changes -> first value at closes index 3
    expect(out[3]).toBe(100);
  });

  it("is null during warmup", () => {
    const closes = [1, 2, 3];
    const out = rsi(closes, 14);
    expect(out.every((v) => v === null)).toBe(true);
  });
});

describe("atr", () => {
  it("uses high-low as true range on the first bar (no prior close)", () => {
    const candles: Candle[] = [
      { openTime: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { openTime: 1, open: 11, high: 13, low: 10, close: 12, volume: 1 },
    ];
    const out = atr(candles, 1);
    // length=1 -> rma seeds immediately at index 0 with the first TR value
    expect(out[0]).toBeCloseTo(12 - 9, 10);
  });
});

describe("crossover / crossunder", () => {
  it("detects a was <= b previously and a > b now", () => {
    const a = [1, 2, 5];
    const b = [3, 3, 3];
    expect(crossover(a, b, 0)).toBe(false); // no previous bar
    expect(crossover(a, b, 1)).toBe(false); // 2 <= 3, still <=
    expect(crossover(a, b, 2)).toBe(true); // 2<=3 previously, 5>3 now
  });

  it("detects a was >= b previously and a < b now", () => {
    const a = [5, 4, 1];
    const b = [3, 3, 3];
    expect(crossunder(a, b, 2)).toBe(true);
  });

  it("is false when either series has a null value", () => {
    const a = [null, 5];
    const b = [3, 3];
    expect(crossover(a, b, 1)).toBe(false);
  });
});

// ── indicators added for the intraday strategies ────────────────────────────

function bar(high: number, low: number, close: number, volume = 1): Candle {
  return { openTime: 0, open: close, high, low, close, volume };
}

describe("adx", () => {
  it("is high for a clean one-directional trend", () => {
    // Each bar steps strictly up: all directional movement is +DM, so DX -> ~100.
    const candles = Array.from({ length: 60 }, (_, i) => bar(100 + i * 2, 99 + i * 2, 100 + i * 2));
    const out = adx(candles, 14);
    expect(out[59]).not.toBeNull();
    expect(out[59]!).toBeGreaterThan(90);
  });

  it("is low for a choppy, directionless series", () => {
    // Alternating up/down bars: +DM and -DM roughly cancel, so DX stays near 0.
    const candles = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? bar(102, 98, 100) : bar(101, 97, 99)));
    const out = adx(candles, 14);
    expect(out[79]).not.toBeNull();
    expect(out[79]!).toBeLessThan(40);
  });

  it("stays null through warmup, then produces a contiguous series", () => {
    // ADX smooths DX, which is itself already smoothed — so it warms up roughly twice over. What
    // matters is that once it starts there are no interior nulls, since rmaAfterWarmup assumes it.
    const candles = Array.from({ length: 60 }, (_, i) => bar(100 + i, 99 + i, 100 + i));
    const out = adx(candles, 14);
    const firstDefined = out.findIndex((v) => v != null);
    expect(firstDefined).toBeGreaterThan(14);
    expect(out.slice(firstDefined).every((v) => v != null)).toBe(true);
  });

  it("survives a zero-range series without producing NaN or a hole", () => {
    const candles = Array.from({ length: 60 }, () => bar(100, 100, 100));
    const out = adx(candles, 14);
    expect(out.every((v) => v == null || Number.isFinite(v))).toBe(true);
  });
});

describe("donchian", () => {
  it("excludes the current bar from its own channel", () => {
    // This is the property the whole thing rests on: a bar that makes a new high must be ABOVE
    // the channel, otherwise breakout/sweep detection can never fire.
    const candles = [bar(10, 5, 8), bar(11, 6, 9), bar(12, 7, 10), bar(50, 8, 40)];
    const { upper } = donchian(candles, 3);
    expect(upper[3]).toBe(12); // max of bars 0..2, NOT the current bar's 50
    expect(candles[3]!.high).toBeGreaterThan(upper[3]!);
  });

  it("tracks the lower channel over the prior bars", () => {
    const candles = [bar(10, 5, 8), bar(11, 3, 9), bar(12, 7, 10), bar(13, 1, 11)];
    const { lower } = donchian(candles, 3);
    expect(lower[3]).toBe(3); // min of bars 0..2
  });

  it("is null until a full prior window exists", () => {
    const candles = [bar(10, 5, 8), bar(11, 6, 9), bar(12, 7, 10)];
    const { upper, lower } = donchian(candles, 3);
    expect(upper.slice(0, 3)).toEqual([null, null, null]);
    expect(lower.slice(0, 3)).toEqual([null, null, null]);
  });

  it("slides the window rather than tracking a running max", () => {
    // Once the early spike falls out of the window the channel must come back down.
    const candles = [bar(99, 1, 50), bar(10, 5, 8), bar(11, 6, 9), bar(12, 7, 10), bar(13, 8, 11)];
    const { upper } = donchian(candles, 3);
    expect(upper[3]).toBe(99); // bars 0..2 still include the spike
    expect(upper[4]).toBe(12); // bars 1..3 — spike has expired
  });
});

describe("rollingPercentile", () => {
  it("ranks the largest value in its window at 100", () => {
    const out = rollingPercentile([1, 2, 3, 4, 5], 5);
    expect(out[4]).toBeCloseTo(100, 10);
  });

  it("ranks the smallest value in its window at 1/length", () => {
    const out = rollingPercentile([5, 4, 3, 2, 1], 5);
    expect(out[4]).toBeCloseTo(20, 10); // only itself is <= itself
  });

  it("is null until the window is full", () => {
    const out = rollingPercentile([1, 2, 3], 5);
    expect(out).toEqual([null, null, null]);
  });

  it("is null where the window contains a warmup null", () => {
    // Gating on a partially-warmed window would let through exactly the ungated signals the
    // regime filter exists to suppress.
    const out = rollingPercentile([null, 2, 3], 3);
    expect(out[2]).toBeNull();
  });
});

describe("sessionVwap", () => {
  it("weights by volume rather than averaging prices evenly", () => {
    // hlc3 is 10 on the first bar and 20 on the second, but the second carries 9x the volume.
    const candles = [bar(10, 10, 10, 1), bar(20, 20, 20, 9)];
    const { vwap } = sessionVwap(candles, [0, 0]);
    expect(vwap[0]).toBeCloseTo(10, 10);
    expect(vwap[1]).toBeCloseTo(19, 10); // (10*1 + 20*9) / 10
  });

  it("resets its accumulation when the session id changes", () => {
    const candles = [bar(10, 10, 10, 1), bar(20, 20, 20, 1), bar(30, 30, 30, 1)];
    const { vwap } = sessionVwap(candles, [0, 0, 1]);
    expect(vwap[1]).toBeCloseTo(15, 10); // both bars of session 0
    expect(vwap[2]).toBeCloseTo(30, 10); // session 1 starts fresh, not 20
  });

  it("reports zero sigma for a flat session and positive sigma once price disperses", () => {
    const flat = sessionVwap([bar(10, 10, 10), bar(10, 10, 10)], [0, 0]);
    expect(flat.sigma[1]).toBeCloseTo(0, 10);

    const spread = sessionVwap([bar(10, 10, 10), bar(20, 20, 20)], [0, 0]);
    expect(spread.sigma[1]!).toBeGreaterThan(0);
  });

  it("leaves VWAP null while a session has no volume at all", () => {
    const { vwap, sigma } = sessionVwap([bar(10, 10, 10, 0)], [0]);
    expect(vwap[0]).toBeNull();
    expect(sigma[0]).toBeNull();
  });
});
