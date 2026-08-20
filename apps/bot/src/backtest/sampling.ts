/**
 * Deterministic PRNG (mulberry32) — same seed always produces the same sequence. Used instead
 * of Math.random() so buildCoarseGrid/refineAround stay deterministic for a given strategy +
 * budget, matching their existing "same input -> same grid" contract.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small string -> 32-bit int hash (djb2), for deriving a seed from a strategy id — different
 * strategies get different (but each individually reproducible) sample patterns, rather than
 * every strategy sharing one global sequence. Not cryptographic; just needs to spread inputs. */
export function hashSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * Latin Hypercube sample of `count` points across `dims` continuous [0,1) dimensions. Each
 * dimension is independently divided into `count` equal-probability strata (one sample per
 * stratum, jittered within it), and each dimension's stratum order is independently shuffled —
 * so every dimension's own marginal distribution is evenly covered, AND the shuffling spreads
 * the *joint* combinations across the space instead of correlating them.
 *
 * This replaces the naive approach of Cartesian-expanding every param's candidate values and
 * slicing the first N: that keeps whichever combinations happen to come first in iteration
 * order, which systematically favors low values of later-processed params and leaves whole
 * regions of the space completely unvisited once the budget cap is hit mid-expansion. LHS
 * samples the joint space directly, so truncation never has that effect — there's nothing to
 * truncate, the budget IS the sample count.
 */
export function latinHypercube(count: number, dims: number, rng: () => number): number[][] {
  if (count <= 0 || dims <= 0) return [];
  const samples: number[][] = Array.from({ length: count }, () => []);
  for (let d = 0; d < dims; d++) {
    const strata = Array.from({ length: count }, (_, i) => i);
    for (let i = strata.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = strata[i]!;
      strata[i] = strata[j]!;
      strata[j] = tmp;
    }
    for (let i = 0; i < count; i++) {
      samples[i]!.push((strata[i]! + rng()) / count);
    }
  }
  return samples;
}
