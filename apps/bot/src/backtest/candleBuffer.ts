import type { Candle } from "./types.js";

export interface SharedCandleBuffer {
  buffer: SharedArrayBuffer;
  length: number;
}

const FIELDS = 6; // openTime, open, high, low, close, volume — fixed column order, see pack/unpack below.

/**
 * Packs a Candle[] into a single columnar SharedArrayBuffer (one Float64 per field, laid out
 * [openTime, open, high, low, close, volume] per row) so it can be handed to worker threads by
 * reference. Posting a SharedArrayBuffer over postMessage copies only a small handle, not the
 * underlying memory — unlike a plain Candle[], which would be structurally cloned (deep-copied)
 * on every message. See workerPool.ts, which packs once per distinct candle array and reuses the
 * same buffer across every task dispatched against it.
 */
export function packCandles(candles: readonly Candle[]): SharedCandleBuffer {
  const length = candles.length;
  const buffer = new SharedArrayBuffer(length * FIELDS * Float64Array.BYTES_PER_ELEMENT);
  const view = new Float64Array(buffer);
  for (let i = 0; i < length; i++) {
    const c = candles[i]!;
    const base = i * FIELDS;
    view[base] = c.openTime;
    view[base + 1] = c.open;
    view[base + 2] = c.high;
    view[base + 3] = c.low;
    view[base + 4] = c.close;
    view[base + 5] = c.volume;
  }
  return { buffer, length };
}

/**
 * Reconstructs a plain Candle[] from a shared buffer — real objects, since strategies and the
 * engine index into `.open`/`.close`/etc. by property access. This allocation is the actual CPU
 * cost packCandles exists to amortize (not eliminate): call it once per (worker, distinct candle
 * set) and cache the result, rather than once per backtest task.
 */
export function unpackCandles({ buffer, length }: SharedCandleBuffer): Candle[] {
  const view = new Float64Array(buffer);
  const candles = new Array<Candle>(length);
  for (let i = 0; i < length; i++) {
    const base = i * FIELDS;
    candles[i] = {
      openTime: view[base]!,
      open: view[base + 1]!,
      high: view[base + 2]!,
      low: view[base + 3]!,
      close: view[base + 4]!,
      volume: view[base + 5]!,
    };
  }
  return candles;
}
