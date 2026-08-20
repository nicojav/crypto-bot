import { describe, it, expect } from "vitest";
import { mulberry32, hashSeed, latinHypercube } from "./sampling.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("stays within [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("hashSeed", () => {
  it("is deterministic for the same string", () => {
    expect(hashSeed("bbMeanReversion")).toBe(hashSeed("bbMeanReversion"));
  });

  it("differs across different strings", () => {
    expect(hashSeed("bbMeanReversion")).not.toBe(hashSeed("customMaCross"));
  });
});

describe("latinHypercube", () => {
  it("returns count points, each with `dims` values in [0, 1)", () => {
    const rng = mulberry32(1);
    const samples = latinHypercube(20, 3, rng);
    expect(samples).toHaveLength(20);
    for (const point of samples) {
      expect(point).toHaveLength(3);
      for (const v of point) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("stratifies each dimension — one sample per equal-width bucket, not clustered", () => {
    const rng = mulberry32(2);
    const count = 50;
    const samples = latinHypercube(count, 1, rng);
    const values = samples.map((p) => p[0]!).sort((a, b) => a - b);
    // With one sample per stratum, the i-th smallest value must fall in [i/count, (i+1)/count).
    for (let i = 0; i < count; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(i / count);
      expect(values[i]).toBeLessThan((i + 1) / count);
    }
  });

  it("is deterministic given the same rng seed", () => {
    const a = latinHypercube(10, 4, mulberry32(99));
    const b = latinHypercube(10, 4, mulberry32(99));
    expect(a).toEqual(b);
  });

  it("returns an empty array for zero count or zero dimensions", () => {
    const rng = mulberry32(1);
    expect(latinHypercube(0, 3, rng)).toEqual([]);
    expect(latinHypercube(5, 0, rng)).toEqual([]);
  });
});
