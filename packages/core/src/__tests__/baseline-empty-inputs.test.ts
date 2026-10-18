import { describe, it, expect } from 'vitest';
import { computeCurrent } from '../baseline/current.js';
import { resolveDiscoveryGrain } from '../baseline/grain.js';
import { maxOf, median, minOf, percentile } from '../baseline/stats.js';
import { compareByDate, runRateSeries } from '../baseline/window.js';
import type { BaselineDailyPoint } from '../types/baseline.js';
import { asDateString, asDimensionId, asDollars } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';

/** Baseline math on inputs with nothing (or almost nothing) in them. */

function point(date: string, cost: number): BaselineDailyPoint {
  return { date: asDateString(date), cost: asDollars(cost) };
}

/** A list with slots but no points in them (a sparse array). */
function slotsWithoutPoints(length: number): BaselineDailyPoint[] {
  const series: BaselineDailyPoint[] = [];
  series.length = length;
  return series;
}

describe('a series with slots but no points', () => {
  it('has no current average, like an empty series', () => {
    const series = slotsWithoutPoints(3);
    expect(series).toHaveLength(3);
    expect(computeCurrent(series, 7)).toBeNull();
  });

  it('has no run-rate series, like an empty history', () => {
    expect(runRateSeries(slotsWithoutPoints(2), 7)).toEqual([]);
  });

  it('has a percentile of 0, like an empty list', () => {
    const values: number[] = [];
    values.length = 1;
    expect(percentile(values, 50)).toBe(0);
  });
});

describe('degenerate statistics', () => {
  it('returns the only value for every percentile of a one-point series', () => {
    for (const p of [0, 37, 50, 100]) expect(percentile([42], p)).toBe(42);
    expect(median([42])).toBe(42);
  });

  it('reports 0 as the minimum and maximum of an empty series', () => {
    expect(minOf([])).toBe(0);
    expect(maxOf([])).toBe(0);
  });

  it('orders points by date and ties two points on the same day', () => {
    const a = point('2024-03-01', 1);
    const b = point('2024-03-02', 9);
    expect(compareByDate(a, b)).toBe(-1);
    expect(compareByDate(b, a)).toBe(1);
    expect(compareByDate(a, point('2024-03-01', 5))).toBe(0);
  });
});

describe('resolveDiscoveryGrain without a cardinality measurement', () => {
  it('keeps a built-in whose column the probe did not measure', () => {
    const dims: DimensionsConfig = {
      builtIn: [
        { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
        { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' },
        { name: asDimensionId('operation'), label: 'Operation', field: 'operation' },
      ],
      tags: [],
    };
    const grain = resolveDiscoveryGrain({
      dimensions: dims,
      // `operation` was not probed; `resource_id` is measured and high-cardinality.
      cardinalityByColumn: { account_id: 40, resource_id: 90_000 },
      lineItems: 1_000_000,
      bytesPerRow: 16,
      override: [],
    });
    expect(grain.map(d => d.name)).toEqual(['account', 'operation']);
  });
});
