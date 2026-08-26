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
 * Rolling population standard deviation — matches Pine's ta.stdev default (biased=true,
 * divides by `length` not `length-1`). Null until the window is fully populated.
 */
export function stddev(values: readonly number[], length: number): (number | null)[] {
  if (length < 1) throw new Error(`stddev: length must be >= 1, got ${length}`);
  const out = new Array<number | null>(values.length).fill(null);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    sum += v;
    sumSq += v * v;
    if (i >= length) {
      const old = values[i - length]!;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= length - 1) {
      const mean = sum / length;
      const variance = Math.max(0, sumSq / length - mean * mean); // guard tiny negative from fp rounding
      out[i] = Math.sqrt(variance);
    }
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

/**
 * Wilder smoothing over a series that has leading nulls (a warmup gap) — seeds the SMA at the
 * first non-null value instead of at index 0, so chained smoothing (ADX smooths DX, which is
 * itself already smoothed) doesn't lose its seed to the inner indicator's warmup.
 *
 * Assumes no *interior* nulls once the series starts; callers must fill degenerate bars with a
 * real value rather than null. `adx` below does exactly that for the zero-range case.
 */
function rmaAfterWarmup(values: readonly (number | null)[], length: number): (number | null)[] {
  if (length < 1) throw new Error(`rmaAfterWarmup: length must be >= 1, got ${length}`);
  const out = new Array<number | null>(values.length).fill(null);

  let start = 0;
  while (start < values.length && values[start] == null) start++;
  if (start + length > values.length) return out;

  const alpha = 1 / length;
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += values[i] as number;
  out[start + length - 1] = sum / length;
  for (let i = start + length; i < values.length; i++) {
    out[i] = alpha * (values[i] as number) + (1 - alpha) * (out[i - 1] as number);
  }
  return out;
}

/**
 * Average Directional Index — matches Pine's ta.dmi/ta.adx. Measures trend *strength* regardless
 * of direction, which is what makes it the natural regime gate: a mean-reversion strategy wants
 * to fade only while ADX is low (ranging), a breakout strategy wants to fire only while it's high.
 *
 * `adxLength` defaults to `length`, mirroring the usual `ta.adx(len)` shorthand.
 */
export function adx(candles: readonly Candle[], length: number, adxLength: number = length): (number | null)[] {
  if (length < 1) throw new Error(`adx: length must be >= 1, got ${length}`);
  const n = candles.length;
  if (n < 2) return new Array<number | null>(n).fill(null);

  // Directional movement. Bar 0 has no prior bar to change against, so both start at 0 — Pine's
  // ta.change is na there and the rma warmup swallows it either way.
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  const trueRangeRma = rma(trueRange(candles), length);
  const plusRma = rma(plusDM, length);
  const minusRma = rma(minusDM, length);

  const dx = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const tr = trueRangeRma[i];
    const plus = plusRma[i];
    const minus = minusRma[i];
    if (tr == null || plus == null || minus == null) continue; // still warming up
    if (tr === 0) { dx[i] = 0; continue; } // zero range: no directional info, but keep the series contiguous for rmaAfterWarmup
    const plusDi = (100 * plus) / tr;
    const minusDi = (100 * minus) / tr;
    const sum = plusDi + minusDi;
    dx[i] = (100 * Math.abs(plusDi - minusDi)) / (sum === 0 ? 1 : sum);
  }

  return rmaAfterWarmup(dx, adxLength);
}

/**
 * Sliding extreme over the `length` bars ENDING AT i-1 — the current bar is deliberately
 * excluded. Sweep/breakout detection compares the current bar against the range it is breaking
 * out of; if the current bar were included in its own window, `high[i] > upper[i]` could never
 * be true and the comparison would be dead on arrival.
 *
 * Monotonic deque, O(n) — a naive O(n·length) scan is fine for one backtest but the Strategy
 * Finder runs thousands over six-figure candle arrays.
 */
function slidingExtreme(values: readonly number[], length: number, mode: "max" | "min"): (number | null)[] {
  const n = values.length;
  const out = new Array<number | null>(n).fill(null);
  const deque: number[] = []; // indices; their values stay monotonic
  const dominates = mode === "max"
    ? (a: number, b: number) => a >= b
    : (a: number, b: number) => a <= b;

  for (let i = 1; i < n; i++) {
    const entering = i - 1;
    while (deque.length > 0 && dominates(values[entering]!, values[deque[deque.length - 1]!]!)) deque.pop();
    deque.push(entering);
    while (deque[0]! < i - length) deque.shift(); // deque stays bounded by `length`, so shift is cheap
    if (i >= length) out[i] = values[deque[0]!]!;
  }
  return out;
}

/** Donchian channel over the `length` bars before the current one — see slidingExtreme on why the current bar is excluded. */
export function donchian(candles: readonly Candle[], length: number): { upper: (number | null)[]; lower: (number | null)[] } {
  if (length < 1) throw new Error(`donchian: length must be >= 1, got ${length}`);
  return {
    upper: slidingExtreme(candles.map((c) => c.high), length, "max"),
    lower: slidingExtreme(candles.map((c) => c.low), length, "min"),
  };
}

/**
 * Percentile rank (0–100) of each value within the trailing `length` bars, current bar included.
 * Turns an absolute indicator into a self-normalizing one: "ATR is 0.4% of price" means nothing
 * on its own, but "ATR is in the 90th percentile of its own last 96 bars" is a regime statement
 * that transfers across symbols and volatility eras. Null until the window is full.
 */
export function rollingPercentile(values: readonly (number | null)[], length: number): (number | null)[] {
  if (length < 1) throw new Error(`rollingPercentile: length must be >= 1, got ${length}`);
  const n = values.length;
  const out = new Array<number | null>(n).fill(null);

  for (let i = length - 1; i < n; i++) {
    const current = values[i];
    if (current == null) continue;
    let atOrBelow = 0;
    let counted = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const v = values[j];
      if (v == null) continue;
      counted++;
      if (v <= current) atOrBelow++;
    }
    if (counted === length) out[i] = (atOrBelow / counted) * 100;
  }
  return out;
}

/**
 * Volume-weighted average price and volume-weighted standard deviation, accumulated within each
 * session and reset when `sessionIds` changes (see sessions.ts). Anchoring matters: a rolling
 * mean has no particular significance to anyone, whereas the session VWAP is a level a large
 * share of intraday participants actually benchmark against, which is why price reverts to it.
 *
 * Typical price is hlc3, matching Pine's `ta.vwap` default.
 */
export function sessionVwap(
  candles: readonly Candle[],
  sessionIds: readonly number[],
): { vwap: (number | null)[]; sigma: (number | null)[] } {
  const n = candles.length;
  const vwap = new Array<number | null>(n).fill(null);
  const sigma = new Array<number | null>(n).fill(null);

  let cumVol = 0;
  let cumPv = 0;
  let cumPPv = 0; // Σ v·p², for the volume-weighted variance below

  for (let i = 0; i < n; i++) {
    if (i === 0 || sessionIds[i] !== sessionIds[i - 1]) {
      cumVol = 0;
      cumPv = 0;
      cumPPv = 0;
    }
    const c = candles[i]!;
    const price = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 0;

    cumVol += vol;
    cumPv += price * vol;
    cumPPv += price * price * vol;

    if (cumVol <= 0) continue; // no volume yet this session — VWAP undefined rather than 0
    const mean = cumPv / cumVol;
    vwap[i] = mean;
    const variance = Math.max(0, cumPPv / cumVol - mean * mean); // guard tiny negative from fp rounding, as in stddev()
    sigma[i] = Math.sqrt(variance);
  }
  return { vwap, sigma };
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
