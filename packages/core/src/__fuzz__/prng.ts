/**
 * Deterministic seeded PRNG for the query fuzzer.
 *
 * A fuzz run is only useful if a failure can be replayed exactly. We seed a
 * mulberry32 generator (small, fast, well-distributed for non-crypto use) so a
 * (seed, caseCount) pair reproduces the identical sequence of generated cases.
 * The standard library `Math.random` is unseedable and would make a found bug
 * impossible to reproduce.
 */
export interface Rng {
  /** Next float in [0, 1). */
  (): number;
}

/** Create a deterministic generator from a 32-bit seed. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** True with probability `p`. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** Pick one element from a non-empty pool. */
export function pick<T>(rng: Rng, pool: readonly T[]): T {
  const value = pool[Math.floor(rng() * pool.length)];
  if (value === undefined) {
    throw new Error('pick() called on an empty pool');
  }
  return value;
}

/** A fresh array of `count` picks (with replacement). */
export function sample<T>(rng: Rng, pool: readonly T[], count: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(pick(rng, pool));
  return out;
}
