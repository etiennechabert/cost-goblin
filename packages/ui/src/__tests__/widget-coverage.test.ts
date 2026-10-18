import { describe, it, expect } from 'vitest';
import type { CostResult, DateRange } from '@costgoblin/core/browser';
import { asDateString, asDollars, asEntityRef } from '@costgoblin/core/browser';
import { hasSufficientCoverage } from '../widgets/widget.js';

// 28 days: 80% of it is 22.4.
const ASKED: DateRange = { start: asDateString('2026-01-04'), end: asDateString('2026-01-31') };

function result(fields: { readonly dateRange?: DateRange; readonly coveredDays?: number; readonly cost?: number } = {}): CostResult {
  const cost = fields.cost ?? 100;
  return {
    rows: cost === 0 ? [] : [{ entity: asEntityRef('prod'), totalCost: asDollars(cost), serviceCosts: {} }],
    totalCost: asDollars(cost),
    topServices: [],
    dateRange: fields.dateRange ?? ASKED,
    ...(fields.coveredDays === undefined ? {} : { coveredDays: fields.coveredDays }),
  };
}

describe('hasSufficientCoverage', () => {
  it('goes by the covered days the main process reports, not the range it echoes', () => {
    expect(hasSufficientCoverage(result({ coveredDays: 0 }), ASKED)).toBe(false);
    expect(hasSufficientCoverage(result({ coveredDays: 22 }), ASKED)).toBe(false);
    expect(hasSufficientCoverage(result({ coveredDays: 23 }), ASKED)).toBe(true);
    expect(hasSufficientCoverage(result({ coveredDays: 28 }), ASKED)).toBe(true);
  });

  it('accepts a fully covered period with no spend', () => {
    expect(hasSufficientCoverage(result({ coveredDays: 28, cost: 0 }), ASKED)).toBe(true);
  });

  it('takes the dateRange as the covered span when a result has no covered days', () => {
    expect(hasSufficientCoverage(result(), ASKED)).toBe(true);
    const lastWeek = { start: asDateString('2026-01-25'), end: asDateString('2026-01-31') };
    expect(hasSufficientCoverage(result({ dateRange: lastWeek }), ASKED)).toBe(false);
  });
});
