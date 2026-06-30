import { describe, it, expect } from 'vitest';
import { effectiveBands, computeSavings, deriveStatus } from '../baseline/savings.js';
import type { BaselineBands, BaselineCurrent } from '../types/baseline.js';
import { asDateString, asDollars } from '../types/branded.js';

const AUTO: BaselineBands = {
  lower: asDollars(10),
  upper: asDollars(100),
  median: asDollars(55),
  mean: asDollars(55),
  std: asDollars(5),
  min: asDollars(0),
  max: asDollars(120),
};

function current(avg: number): BaselineCurrent {
  return { avgDaily: asDollars(avg), windowStart: asDateString('2024-01-01'), windowEnd: asDateString('2024-01-30'), days: 30 };
}

describe('effectiveBands', () => {
  it('falls back to automated when no manual override', () => {
    const e = effectiveBands(AUTO, undefined, []);
    expect(e.lower).toBe(10);
    expect(e.upper).toBe(100);
  });

  it('manual absolute wins per-side; unset side falls back', () => {
    const e = effectiveBands(AUTO, { mode: 'absolute', lower: 20 }, []);
    expect(e.lower).toBe(20);
    expect(e.upper).toBe(100);
  });

  it('keeps upper >= lower', () => {
    const e = effectiveBands(AUTO, { mode: 'absolute', lower: 200 }, []);
    expect(e.lower).toBe(200);
    expect(e.upper).toBe(200);
  });

  it('percentile mode resolves against the series (lower excludes zeros)', () => {
    const costs = [0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const e = effectiveBands(AUTO, { mode: 'percentile', lower: 0, upper: 100 }, costs);
    expect(e.lower).toBe(10); // smallest non-zero
    expect(e.upper).toBe(100);
  });
});

describe('computeSavings', () => {
  it('potential above floor, realized below ceiling, monthly x30', () => {
    const s = computeSavings(current(50), { lower: asDollars(10), upper: asDollars(100) });
    expect(s.potentialDaily).toBe(40);
    expect(s.realizedDaily).toBe(50);
    expect(s.potentialMonthly).toBe(1200);
    expect(s.realizedMonthly).toBe(1500);
  });

  it('floors at zero', () => {
    const s = computeSavings(current(5), { lower: asDollars(10), upper: asDollars(100) });
    expect(s.potentialDaily).toBe(0);
    expect(s.realizedDaily).toBe(95);
  });

  it('null current → all zero', () => {
    const s = computeSavings(null, { lower: asDollars(10), upper: asDollars(100) });
    expect(s.potentialDaily).toBe(0);
    expect(s.realizedDaily).toBe(0);
  });
});

describe('deriveStatus', () => {
  const bands = { lower: asDollars(10), upper: asDollars(100) };
  const opts = { minDataPoints: 30, subCentFloor: 0.01, overPctOverLower: 0 };

  it('insufficient-data on null/too-few-points/sub-floor', () => {
    expect(deriveStatus(null, bands, 100, opts)).toBe('insufficient-data');
    expect(deriveStatus(current(50), bands, 10, opts)).toBe('insufficient-data');
    expect(deriveStatus(current(0), bands, 100, opts)).toBe('insufficient-data');
  });

  it('under / over / in-band', () => {
    expect(deriveStatus(current(5), bands, 100, opts)).toBe('under');
    expect(deriveStatus(current(150), bands, 100, opts)).toBe('over');
    expect(deriveStatus(current(50), bands, 100, opts)).toBe('in-band');
  });

  it('flags over inside the band when above the configured % over lower', () => {
    expect(deriveStatus(current(50), bands, 100, { ...opts, overPctOverLower: 100 })).toBe('over');
    expect(deriveStatus(current(15), bands, 100, { ...opts, overPctOverLower: 100 })).toBe('in-band');
  });
});
