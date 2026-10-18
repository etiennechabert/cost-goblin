import { describe, it, expect } from 'vitest';
import { effectiveBands } from '../baseline/savings.js';
import type { BaselineBands } from '../types/baseline.js';
import { asDollars } from '../types/branded.js';

/** A manual band may set one edge only; the other keeps the automated value,
 *  in either override mode. */

const AUTO: BaselineBands = {
  lower: asDollars(10),
  upper: asDollars(100),
  median: asDollars(55),
  mean: asDollars(55),
  std: asDollars(5),
  min: asDollars(0),
  max: asDollars(120),
};

/** Two idle days, then $10..$100: 12 days in all, 10 of them non-zero. */
const COSTS = [0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

describe('effectiveBands with a one-sided manual override', () => {
  it('absolute: overriding only the upper edge keeps the automated lower edge', () => {
    expect(effectiveBands(AUTO, { mode: 'absolute', upper: 80 }, COSTS)).toEqual({ lower: 10, upper: 80 });
  });

  it('absolute: an override that sets neither edge changes nothing', () => {
    expect(effectiveBands(AUTO, { mode: 'absolute' }, COSTS)).toEqual({ lower: 10, upper: 100 });
  });

  it('percentile: overriding only the lower edge resolves it over the non-zero days', () => {
    // 25th percentile of $10..$100: rank 2.25 → 30 + 0.25 × 10.
    expect(effectiveBands(AUTO, { mode: 'percentile', lower: 25 }, COSTS)).toEqual({ lower: 32.5, upper: 100 });
  });

  it('percentile: overriding only the upper edge resolves it over every day, idle ones included', () => {
    // Median of all 12 days: (40 + 50) / 2.
    expect(effectiveBands(AUTO, { mode: 'percentile', upper: 50 }, COSTS)).toEqual({ lower: 10, upper: 45 });
  });

  it('percentile: an upper edge that resolves below the lower one is lifted to it', () => {
    // The 0th percentile of every day is an idle $0 day.
    expect(effectiveBands(AUTO, { mode: 'percentile', upper: 0 }, COSTS)).toEqual({ lower: 10, upper: 10 });
  });
});
