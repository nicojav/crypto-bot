import { describe, it, expect } from "vitest";
import { ema, sma, rma, rsi, atr, crossover, crossunder } from "./indicators.js";
import type { Candle } from "./types.js";

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
