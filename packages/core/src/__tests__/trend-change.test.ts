import { describe, it, expect } from 'vitest';
import { SecurityError } from '../query/identifier-validator.js';
import { isNewTrend, meetsTrendThresholds, NEW_TREND_PERCENT, trendPercentChange, trendPercentChangeSql } from '../query/trend-change.js';

function row(currentCost: number, previousCost: number): {
  currentCost: number;
  previousCost: number;
  delta: number;
  percentChange: number;
} {
  return {
    currentCost,
    previousCost,
    delta: currentCost - previousCost,
    percentChange: trendPercentChange(currentCost, previousCost),
  };
}

describe('trendPercentChange', () => {
  it('is the change relative to the previous period', () => {
    expect(trendPercentChange(150, 100)).toBe(50);
    expect(trendPercentChange(25, 100)).toBe(-75);
    expect(trendPercentChange(0, 100)).toBe(-100);
  });

  it('reports a change from a $0 previous period as ±100, signed like the change', () => {
    expect(trendPercentChange(250, 0)).toBe(NEW_TREND_PERCENT);
    expect(trendPercentChange(-75, 0)).toBe(-NEW_TREND_PERCENT);
    expect(trendPercentChange(0, 0)).toBe(0);
  });
});

describe('isNewTrend', () => {
  it('is true only when the previous period had no cost and the current one has some', () => {
    expect(isNewTrend(250, 0)).toBe(true);
    expect(isNewTrend(-75, 0)).toBe(true);
    expect(isNewTrend(0, 0)).toBe(false);
    expect(isNewTrend(250, 1)).toBe(false);
    expect(isNewTrend(0, 100)).toBe(false);
  });
});

describe('meetsTrendThresholds', () => {
  it('drops a change below either threshold', () => {
    expect(meetsTrendThresholds(row(104, 100), 1, 5)).toBe(false);
    expect(meetsTrendThresholds(row(100.5, 100), 1, 0)).toBe(false);
    expect(meetsTrendThresholds(row(110, 100), 1, 5)).toBe(true);
    expect(meetsTrendThresholds(row(90, 100), 1, 5)).toBe(true);
  });

  it('keeps new spend and new credits whatever the percent threshold', () => {
    // From $0 the relative change is unbounded: its ±100 display value must
    // not be compared, or a threshold above 100 would drop all new spend.
    for (const percentThreshold of [0, 5, 100, 500]) {
      expect(meetsTrendThresholds(row(250, 0), 1, percentThreshold)).toBe(true);
      expect(meetsTrendThresholds(row(-75, 0), 1, percentThreshold)).toBe(true);
    }
  });

  it('still holds new spend to the delta threshold', () => {
    expect(meetsTrendThresholds(row(0.5, 0), 1, 0)).toBe(false);
    expect(meetsTrendThresholds(row(-0.5, 0), 1, 0)).toBe(false);
  });

  it('does not treat an entity with no cost in either period as new', () => {
    expect(meetsTrendThresholds(row(0, 0), 0, 5)).toBe(false);
  });
});

describe('trendPercentChangeSql', () => {
  it('refuses anything but a plain column identifier, since both are interpolated bare', () => {
    expect(trendPercentChangeSql('current_cost', 'previous_cost')).toContain('previous_cost = 0');
    expect(() => trendPercentChangeSql('current_cost); DROP TABLE t; --', 'previous_cost')).toThrow(SecurityError);
    expect(() => trendPercentChangeSql('current_cost', '1 OR 1=1')).toThrow(SecurityError);
  });
});
