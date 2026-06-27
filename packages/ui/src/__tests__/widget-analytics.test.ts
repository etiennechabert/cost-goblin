import { describe, it, expect } from 'vitest';
import { asDollars, asEntityRef } from '@costgoblin/core/browser';
import type { TrendRow } from '@costgoblin/core/browser';
import { buildWaterfall } from '../lib/waterfall.js';
import { gini, buildPareto } from '../lib/concentration.js';
import { toCumulative, projectPeriodEnd } from '../lib/day-series.js';
import { decomposePriceVolume } from '../lib/price-volume.js';

function trendRow(entity: string, previousCost: number, currentCost: number): TrendRow {
  return {
    entity: asEntityRef(entity),
    previousCost: asDollars(previousCost),
    currentCost: asDollars(currentCost),
    delta: asDollars(currentCost - previousCost),
    percentChange: previousCost === 0 ? 0 : ((currentCost - previousCost) / previousCost) * 100,
  };
}

describe('buildWaterfall', () => {
  const rows = [
    trendRow('EC2', 100, 148),
    trendRow('RDS', 60, 82),
    trendRow('S3', 40, 28),
    trendRow('Lambda', 10, 12),
    trendRow('SNS', 5, 6),
  ];

  it('anchors to the period totals', () => {
    const m = buildWaterfall(rows, 8);
    expect(m.startTotal).toBe(215);
    expect(m.endTotal).toBe(276);
    expect(m.netDelta).toBe(61);
    expect(m.steps[0]?.kind).toBe('start');
    expect(m.steps.at(-1)?.kind).toBe('end');
  });

  it('reconciles: the last mover/other step lands on the end total', () => {
    const m = buildWaterfall(rows, 8);
    const stepsBeforeEnd = m.steps.slice(1, -1);
    const lastRunning = stepsBeforeEnd.at(-1)?.end ?? m.startTotal;
    expect(lastRunning).toBeCloseTo(m.endTotal, 6);
  });

  it('folds movers beyond topN into a single signed Other step', () => {
    const m = buildWaterfall(rows, 2);
    const other = m.steps.find(s => s.kind === 'other');
    expect(other).toBeDefined();
    expect(m.otherCount).toBe(3);
    // S3 (-12) + Lambda (+2) + SNS (+1) = -9
    expect(other?.delta).toBeCloseTo(-9, 6);
  });

  it('orders named movers by absolute delta and tags direction', () => {
    const m = buildWaterfall(rows, 8);
    const named = m.steps.filter(s => s.kind === 'increase' || s.kind === 'decrease');
    expect(named[0]?.name).toBe('EC2');
    expect(named.find(s => s.name === 'S3')?.kind).toBe('decrease');
  });
});

describe('gini', () => {
  it('is 0 for a perfectly even distribution', () => {
    expect(gini([10, 10, 10, 10])).toBeCloseTo(0, 6);
  });

  it('approaches (n-1)/n when one entity dominates', () => {
    // 1 of 5 holds essentially everything
    expect(gini([1000, 0.01, 0.01, 0.01, 0.01])).toBeGreaterThan(0.75);
  });

  it('ignores zero and negative values, and is empty-safe', () => {
    expect(gini([])).toBe(0);
    expect(gini([0, -5])).toBe(0);
  });
});

describe('buildPareto', () => {
  it('produces a monotonic cumulative share reaching 1', () => {
    const m = buildPareto([
      { name: 'a', cost: 50 },
      { name: 'b', cost: 30 },
      { name: 'c', cost: 20 },
    ], 3);
    expect(m.total).toBe(100);
    expect(m.points.map(p => p.cumPct)).toEqual([0.5, 0.8, 1]);
    expect(m.points.at(-1)?.cumPct).toBeCloseTo(1, 6);
  });

  it('finds the 80% cutoff prefix', () => {
    const m = buildPareto([
      { name: 'a', cost: 50 },
      { name: 'b', cost: 30 },
      { name: 'c', cost: 20 },
    ], 3);
    expect(m.cutoff).toEqual({ count: 2, pct: 0.8 });
  });

  it('flags capping when distinctTotal exceeds returned rows', () => {
    const m = buildPareto([{ name: 'a', cost: 10 }], 500);
    expect(m.capped).toBe(true);
    expect(m.distinctTotal).toBe(500);
  });
});

describe('day-series', () => {
  it('accumulates daily totals by position', () => {
    const c = toCumulative([
      { date: '2026-06-01', total: 10 },
      { date: '2026-06-02', total: 15 },
      { date: '2026-06-03', total: 5 },
    ]);
    expect(c.map(p => p.cumulative)).toEqual([10, 25, 30]);
    expect(c[1]?.dayIndex).toBe(1);
  });

  it('projects the period-end total from the current run-rate', () => {
    const c = toCumulative([
      { date: '2026-06-01', total: 100 },
      { date: '2026-06-02', total: 100 },
    ]);
    // 200 over 2 days → 600 over 6 days
    expect(projectPeriodEnd(c, 6)).toBeCloseTo(600, 6);
  });

  it('returns the actual total once the period is complete', () => {
    const c = toCumulative([{ date: '2026-06-01', total: 100 }]);
    expect(projectPeriodEnd(c, 1)).toBe(100);
    expect(projectPeriodEnd([], 30)).toBeNull();
  });
});

describe('decomposePriceVolume', () => {
  it('splits a change into volume + rate that sum to the total delta', () => {
    const d = decomposePriceVolume({ name: 'EC2', prevCost: 100, currCost: 150, prevUsage: 100, currUsage: 120 });
    expect(d.decomposable).toBe(true);
    expect(d.volumeEffect + d.rateEffect).toBeCloseTo(d.totalDelta, 6);
    // prevRate 1.0; volume = (120-100)*1.0 = 20; rate = (1.25-1.0)*120 = 30
    expect(d.volumeEffect).toBeCloseTo(20, 6);
    expect(d.rateEffect).toBeCloseTo(30, 6);
  });

  it('falls back to a mixed remainder when usage is missing', () => {
    const d = decomposePriceVolume({ name: 'Tax', prevCost: 10, currCost: 14, prevUsage: 0, currUsage: 0 });
    expect(d.decomposable).toBe(false);
    expect(d.volumeEffect).toBe(4);
    expect(d.rateEffect).toBe(0);
  });

  it('computes discount depth from list cost', () => {
    const d = decomposePriceVolume({ name: 'EC2', prevCost: 80, currCost: 90, prevUsage: 10, currUsage: 10, prevListCost: 100, currListCost: 100 });
    expect(d.prevDiscount).toBeCloseTo(0.2, 6);
    expect(d.currDiscount).toBeCloseTo(0.1, 6);
  });
});
