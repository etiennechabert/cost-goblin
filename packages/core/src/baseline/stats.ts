/** Pure descriptive statistics over a numeric series. No I/O, no branded
 *  types — operate on plain numbers so callers can feed `Dollars[]` directly
 *  (a branded number is assignable to number). */

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation. 0 for fewer than two points. */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / values.length);
}

export function minOf(values: readonly number[]): number {
  let lo = Infinity;
  for (const v of values) if (v < lo) lo = v;
  return lo === Infinity ? 0 : lo;
}

export function maxOf(values: readonly number[]): number {
  let hi = -Infinity;
  for (const v of values) if (v > hi) hi = v;
  return hi === -Infinity ? 0 : hi;
}

export interface PercentileOptions {
  /** Drop zero (and negative) values before computing — used for the lower
   *  band so the achievable floor isn't dragged down by weekend/data-gap days. */
  readonly excludeZero?: boolean | undefined;
}

/** Percentile via linear interpolation between closest ranks (numpy default).
 *  `p` is 0..100 and clamped to that range. Empty input → 0. */
export function percentile(values: readonly number[], p: number, opts?: PercentileOptions): number {
  const filtered = opts?.excludeZero === true ? values.filter((v) => v > 0) : values;
  if (filtered.length === 0) return 0;
  const sorted = [...filtered].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo] ?? 0;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi] ?? 0;
  return loVal + (hiVal - loVal) * (rank - lo);
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}
