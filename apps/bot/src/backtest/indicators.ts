import type { Candle } from "./types.js";

/** Exponential moving average — matches Pine's ta.ema: seeded with the first value, alpha = 2/(length+1). */
export function ema(values: readonly number[], length: number): number[] {
  if (length < 1) throw new Error(`ema: length must be >= 1, got ${length}`);
  const alpha = 2 / (length + 1);
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = i === 0 ? values[0]! : alpha * values[i]! + (1 - alpha) * out[i - 1]!;
  }
  return out;
}

/** Simple moving average — matches Pine's ta.sma: null until the window is fully populated. */
export function sma(values: readonly number[], length: number): (number | null)[] {
  if (length < 1) throw new Error(`sma: length must be >= 1, got ${length}`);
  const out = new Array<number | null>(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= length) sum -= values[i - length]!;
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/**
 * Wilder's smoothing (RMA) — underlies Pine's ta.rsi and ta.atr.
 * SMA-seeded over the first `length` values; null until that seed is available.
 */
export function rma(values: readonly number[], length: number): (number | null)[] {
  if (length < 1) throw new Error(`rma: length must be >= 1, got ${length}`);
  const out = new Array<number | null>(values.length).fill(null);
  if (values.length < length) return out;

  const alpha = 1 / length;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i]!;
  out[length - 1] = sum / length;
  for (let i = length; i < values.length; i++) {
    out[i] = alpha * values[i]! + (1 - alpha) * (out[i - 1] as number);
  }
  return out;
}

/** Relative Strength Index — matches Pine's ta.rsi (Wilder-smoothed average gain/loss). */
export function rsi(closes: readonly number[], length: number): (number | null)[] {
  const n = closes.length;
  const out = new Array<number | null>(n).fill(null);
  if (n < 2) return out;

  // change[0] doesn't exist (no prior bar) — Pine's rsi warmup effectively starts at bar 1.
  const gains = new Array<number>(n - 1);
  const losses = new Array<number>(n - 1);
  for (let i = 1; i < n; i++) {
    const change = closes[i]! - closes[i - 1]!;
    gains[i - 1] = Math.max(change, 0);
    losses[i - 1] = Math.max(-change, 0);
  }

  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);

  for (let i = 1; i < n; i++) {
    const ag = avgGain[i - 1];
    const al = avgLoss[i - 1];
    if (ag == null || al == null) continue;
    if (al === 0) { out[i] = ag === 0 ? 50 : 100; continue; }
    const rs = ag / al;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function trueRange(candles: readonly Candle[]): number[] {
  const n = candles.length;
  const tr = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    if (i === 0) {
      tr[i] = c.high - c.low;
    } else {
      const prevClose = candles[i - 1]!.close;
      tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    }
  }
  return tr;
}

/** Average True Range — matches Pine's ta.atr (Wilder-smoothed true range). */
export function atr(candles: readonly Candle[], length: number): (number | null)[] {
  return rma(trueRange(candles), length);
}

/** Pine's ta.crossover: series `a` was <= `b` on the previous bar and is > `b` on the current bar. */
export function crossover(a: readonly (number | null)[], b: readonly (number | null)[], i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1], b0 = b[i - 1], a1 = a[i], b1 = b[i];
  if (a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 <= b0 && a1 > b1;
}

/** Pine's ta.crossunder: series `a` was >= `b` on the previous bar and is < `b` on the current bar. */
export function crossunder(a: readonly (number | null)[], b: readonly (number | null)[], i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1], b0 = b[i - 1], a1 = a[i], b1 = b[i];
  if (a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 >= b0 && a1 < b1;
}
