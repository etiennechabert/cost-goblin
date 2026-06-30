import { describe, it, expect } from 'vitest';
import { mean, stddev, minOf, maxOf, percentile, median } from '../baseline/stats.js';
import { computeBands } from '../baseline/bands.js';
import { computeCurrent } from '../baseline/current.js';
import { expandToWindow, movingAverage } from '../baseline/window.js';
import type { BaselineDailyPoint } from '../types/baseline.js';
import { asDateString, asDollars } from '../types/branded.js';

function series(costs: readonly number[], startDay = 1): readonly BaselineDailyPoint[] {
  return costs.map((c, i) => ({
    date: asDateString(`2024-01-${String(startDay + i).padStart(2, '0')}`),
    cost: asDollars(c),
  }));
}

describe('stats', () => {
  it('mean/min/max/median over a list', () => {
    expect(mean([10, 20, 30])).toBeCloseTo(20);
    expect(mean([])).toBe(0);
    expect(minOf([5, 2, 9])).toBe(2);
    expect(maxOf([5, 2, 9])).toBe(9);
    expect(minOf([])).toBe(0);
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5);
  });

  it('population stddev; 0 for <2 points', () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2);
    expect(stddev([5])).toBe(0);
  });

  it('percentile uses linear interpolation and clamps p', () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(vals, 0)).toBe(10);
    expect(percentile(vals, 100)).toBe(100);
    expect(percentile(vals, 50)).toBeCloseTo(55);
    expect(percentile(vals, 200)).toBe(100);
  });

  it('excludeZero drops zero/negative days', () => {
    expect(percentile([0, 0, 10, 20], 0, { excludeZero: true })).toBe(10);
    expect(percentile([0, 0, 0], 50, { excludeZero: true })).toBe(0);
  });
});

describe('computeBands', () => {
  it('lower excludes zero days; everything else uses all days', () => {
    const s = series([0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const b = computeBands(s, { lowerPct: 10, upperPct: 90 });
    // P10 over the ten non-zero values, linear-interpolated.
    expect(b.lower).toBeCloseTo(19);
    // P90 over all twelve values (two zeros included).
    expect(b.upper).toBeCloseTo(89);
    expect(b.min).toBe(0);
    expect(b.max).toBe(100);
    expect(b.mean).toBeCloseTo(45.833, 2);
  });
});

describe('computeCurrent', () => {
  it('averages the trailing window and reports bounds', () => {
    const c = computeCurrent(series([10, 20, 30, 40, 50]), 3);
    expect(c).not.toBeNull();
    expect(c?.avgDaily).toBeCloseTo(40);
    expect(c?.days).toBe(3);
    expect(c?.windowStart).toBe('2024-01-03');
    expect(c?.windowEnd).toBe('2024-01-05');
  });

  it('returns null for an empty series', () => {
    expect(computeCurrent([], 30)).toBeNull();
  });

  it('sorts before windowing', () => {
    const unsorted: readonly BaselineDailyPoint[] = [
      { date: asDateString('2024-01-05'), cost: asDollars(50) },
      { date: asDateString('2024-01-01'), cost: asDollars(10) },
      { date: asDateString('2024-01-03'), cost: asDollars(30) },
    ];
    const c = computeCurrent(unsorted, 1);
    expect(c?.windowEnd).toBe('2024-01-05');
    expect(c?.avgDaily).toBeCloseTo(50);
  });
});

describe('expandToWindow', () => {
  it('fills missing days with zero over a fixed window ending at endDate', () => {
    const hist: readonly BaselineDailyPoint[] = [
      { date: asDateString('2024-01-03'), cost: asDollars(5) },
      { date: asDateString('2024-01-05'), cost: asDollars(7) },
    ];
    const out = expandToWindow(hist, 5, asDateString('2024-01-05'));
    expect(out.map((p) => p.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']);
    expect(out.map((p) => p.cost)).toEqual([0, 0, 5, 0, 7]);
  });

  it('produces exactly `days` points', () => {
    expect(expandToWindow([], 365, asDateString('2024-12-31'))).toHaveLength(365);
  });
});

describe('movingAverage', () => {
  it('trailing-average aligned to each point', () => {
    const out = movingAverage(series([10, 20, 30]), 2);
    expect(out.map((p) => p.cost)).toEqual([10, 15, 25]);
  });
});
