/**
 * Seeded randomness for the SYNTHETIC parts of a snapshot.
 *
 * mulberry32 is a tiny, well-known 32-bit PRNG: same seed ⇒ same sequence on
 * every machine and Node version. We never call Math.random() or Date.now()
 * while building data, so `data:build` is byte-for-byte reproducible.
 *
 * Tip: derive a separate stream per concern (`rng.fork("oncall")`) so adding a
 * ticket template does not reshuffle every incident time.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash; used to turn a label like "oncall" into a sub-seed. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private readonly next: () => number;
  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }
  /** Independent stream for one concern. */
  fork(label: string): Rng {
    return new Rng((this.seed ^ hash32(label)) >>> 0);
  }
  float(): number {
    return this.next();
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error("pick from empty array");
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  /** Fisher–Yates on a copy. */
  shuffle<T>(xs: readonly T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
  /** `n` distinct items (or all of them if fewer). */
  sample<T>(xs: readonly T[], n: number): T[] {
    return this.shuffle(xs).slice(0, Math.min(n, xs.length));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
