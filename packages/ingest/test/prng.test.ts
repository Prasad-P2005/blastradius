import { describe, expect, it } from "vitest";
import { Rng, hash32, mulberry32 } from "../src/prng.ts";

describe("prng", () => {
  it("is deterministic for a seed", () => {
    const a = mulberry32(1337), b = mulberry32(1337);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it("pins the first values (guards against accidental algorithm changes)", () => {
    const r = mulberry32(1337);
    const first = [r(), r(), r()].map((x) => x.toFixed(8));
    expect(first).toMatchSnapshot();
  });
  it("different seeds and forks give different streams", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    const r = new Rng(42);
    expect(r.fork("a").float()).not.toBe(r.fork("b").float());
    expect(new Rng(42).fork("a").float()).toBe(new Rng(42).fork("a").float());
  });
  it("shuffle/sample/int are deterministic and in range", () => {
    expect(new Rng(7).shuffle([1, 2, 3, 4, 5])).toEqual(new Rng(7).shuffle([1, 2, 3, 4, 5]));
    expect(new Rng(7).shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Rng(9).sample([1, 2, 3], 5)).toHaveLength(3);
    const r = new Rng(3);
    for (let i = 0; i < 100; i++) {
      const v = r.int(2, 4);
      expect(v >= 2 && v <= 4).toBe(true);
    }
  });
  it("hash32 is stable", () => {
    expect(hash32("oncall")).toBe(hash32("oncall"));
    expect(hash32("a")).not.toBe(hash32("b"));
  });
});
