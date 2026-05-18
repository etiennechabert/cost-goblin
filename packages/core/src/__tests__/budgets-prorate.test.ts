import { describe, it, expect } from 'vitest';
import { prorateBudget, computeBudgetProgress } from '../budgets/prorate.js';
import { asBudgetId, asDateString, asDimensionId, asDollars, asEntityRef } from '../types/branded.js';
import type { Budget } from '../types/budgets.js';

function range(start: string, end: string) {
  return { start: asDateString(start), end: asDateString(end) };
}

function makeBudget(annual: number, fiscalYearStart: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12): Budget {
  return {
    id: asBudgetId('b-1'),
    entity: asEntityRef('platform'),
    dimension: asDimensionId('team'),
    annualAmount: asDollars(annual),
    fiscalYearStart,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('prorateBudget', () => {
  it('January FY + mid-FY range computes fraction = daysElapsed/365', () => {
    const result = prorateBudget({
      annualAmount: asDollars(365_000),
      fiscalYearStart: 1,
      dateRange: range('2026-01-01', '2026-03-31'),
    });
    expect(result.elapsedFraction).toBeCloseTo(90 / 365, 5);
    expect(result.proratedBudget).toBeCloseTo(90_000, 1);
  });

  it('April FY clamps to fiscal-year end when range overflows', () => {
    const result = prorateBudget({
      annualAmount: asDollars(120_000),
      fiscalYearStart: 4,
      dateRange: range('2025-04-01', '2030-12-31'),
    });
    expect(result.elapsedFraction).toBe(1);
    expect(result.proratedBudget).toBe(120_000);
  });

  it('range entirely before next FY uses prior FY window', () => {
    // FY starts April, range is January-March → falls within previous FY (Apr 2025–Apr 2026)
    const result = prorateBudget({
      annualAmount: asDollars(365_000),
      fiscalYearStart: 4,
      dateRange: range('2026-01-01', '2026-03-31'),
    });
    // 2025-04-01 → 2026-03-31 is ~365 days; elapsed at end of March is ~365 days
    expect(result.elapsedFraction).toBeGreaterThan(0.99);
    expect(result.elapsedFraction).toBeLessThanOrEqual(1);
  });

  it('leap-year FY uses 366-day denominator', () => {
    // FY = Jan, range = first 90 days of leap year 2024
    const result = prorateBudget({
      annualAmount: asDollars(366_000),
      fiscalYearStart: 1,
      dateRange: range('2024-01-01', '2024-03-30'), // 90 inclusive days
    });
    expect(result.elapsedFraction).toBeCloseTo(90 / 366, 5);
  });

  it('full fiscal year range yields elapsedFraction = 1', () => {
    const result = prorateBudget({
      annualAmount: asDollars(120_000),
      fiscalYearStart: 1,
      dateRange: range('2024-01-01', '2024-12-31'),
    });
    expect(result.elapsedFraction).toBe(1);
    expect(result.proratedBudget).toBe(120_000);
  });

  it('returns 0 fraction for zero-day range without NaN', () => {
    const result = prorateBudget({
      annualAmount: asDollars(100_000),
      fiscalYearStart: 1,
      dateRange: range('2026-06-15', '2026-06-15'),
    });
    expect(Number.isFinite(result.elapsedFraction)).toBe(true);
    expect(result.elapsedFraction).toBeGreaterThanOrEqual(0);
    expect(result.proratedBudget).toBeGreaterThanOrEqual(0);
  });
});

describe('computeBudgetProgress', () => {
  it('reports isOverBudget=true when actualCost exceeds prorated', () => {
    const budget = makeBudget(100_000, 1);
    const progress = computeBudgetProgress(
      budget,
      asDollars(80_000),
      range('2026-01-01', '2026-03-31'),
    );
    // Prorated ≈ 24,657 for 90 days; actual 80k is way over
    expect(progress.isOverBudget).toBe(true);
    expect(progress.percentUsed).toBeGreaterThan(100);
  });

  it('reports isOverBudget=false when actualCost is under prorated', () => {
    const budget = makeBudget(100_000, 1);
    const progress = computeBudgetProgress(
      budget,
      asDollars(1_000),
      range('2026-01-01', '2026-06-30'),
    );
    expect(progress.isOverBudget).toBe(false);
    expect(progress.percentUsed).toBeLessThan(100);
  });

  it('returns percentUsed=0 when proratedBudget is 0 (avoids divide-by-zero)', () => {
    const budget = makeBudget(0, 1);
    const progress = computeBudgetProgress(
      budget,
      asDollars(500),
      range('2026-01-01', '2026-03-31'),
    );
    expect(progress.percentUsed).toBe(0);
    expect(Number.isFinite(progress.percentUsed)).toBe(true);
  });

  it('returns percentUsed=0 when actualCost is 0', () => {
    const budget = makeBudget(100_000, 1);
    const progress = computeBudgetProgress(
      budget,
      asDollars(0),
      range('2026-01-01', '2026-03-31'),
    );
    expect(progress.percentUsed).toBe(0);
    expect(progress.isOverBudget).toBe(false);
  });

  it('carries dateRange through to result', () => {
    const budget = makeBudget(100_000, 1);
    const dateRange = range('2026-01-01', '2026-03-31');
    const progress = computeBudgetProgress(budget, asDollars(10_000), dateRange);
    expect(progress.dateRange).toEqual(dateRange);
  });
});
