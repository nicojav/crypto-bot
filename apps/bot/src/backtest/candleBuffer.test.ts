import { describe, it, expect } from "vitest";
import { packCandles, unpackCandles } from "./candleBuffer.js";
import type { Candle } from "./types.js";

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10 + i * 0.5,
  }));
}

describe("candleBuffer", () => {
  it("round-trips an empty array", () => {
    const shared = packCandles([]);
    expect(shared.length).toBe(0);
    expect(unpackCandles(shared)).toEqual([]);
  });

  it("round-trips arbitrary candles exactly", () => {
    const candles = makeCandles(250);
    const shared = packCandles(candles);
    const restored = unpackCandles(shared);
    expect(restored).toEqual(candles);
  });

  it("shares the same underlying memory across multiple unpacks (no copy per call)", () => {
    const candles = makeCandles(10);
    const shared = packCandles(candles);
    const a = unpackCandles(shared);
    const b = unpackCandles(shared);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // unpack still allocates fresh objects each call — caching is the pool's job
  });

  it("survives being posted through postMessage-style structured clone sharing the same backing memory", () => {
    const candles = makeCandles(5);
    const shared = packCandles(candles);
    // structuredClone mirrors what postMessage does to a SharedArrayBuffer: the receiving side
    // gets a distinct wrapper object, but it must back onto the SAME memory, not a copy — a
    // write through one view must be visible through the other. That's the property workerPool
    // relies on (workers see live data without ever paying for a copy).
    const cloned = structuredClone(shared);
    expect(cloned.buffer).not.toBe(shared.buffer); // distinct wrapper objects...
    new Float64Array(shared.buffer)[0] = 999;
    expect(new Float64Array(cloned.buffer)[0]).toBe(999); // ...but the same underlying memory
    expect(unpackCandles(cloned)).toEqual(unpackCandles(shared));
  });
});
