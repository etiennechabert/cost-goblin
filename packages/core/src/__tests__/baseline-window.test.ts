import { describe, it, expect } from 'vitest';
import { runRateSeries } from '../baseline/window.js';
import type { BaselineDailyPoint } from '../types/baseline.js';
import { asDateString, asDollars } from '../types/branded.js';

const DAY = 86_400_000;
const BASE = Date.parse('2024-01-01T00:00:00Z');
function dayStr(offset: number): string {
  return new Date(BASE + offset * DAY).toISOString().slice(0, 10);
}
function sparse(points: ReadonlyArray<readonly [number, number]>): readonly BaselineDailyPoint[] {
  return points.map(([off, cost]) => ({ date: asDateString(dayStr(off)), cost: asDollars(cost) }));
}

describe('runRateSeries', () => {
  it('is flat for a steady daily cost (warm-up dropped)', () => {
    const hist = sparse(Array.from({ length: 60 }, (_, i) => [i, 100] as const));
    const rr = runRateSeries(hist, 30).map((p) => p.cost);
    expect(rr).toHaveLength(31); // 60 days − 29 warm-up
    for (const c of rr) expect(c).toBeCloseTo(100, 6);
  });

  it('amortizes a monthly spike to the daily run-rate, never the raw spike', () => {
    // $3000 billed once every 30 days, $0 otherwise — a monthly subscription.
    const spikes = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((d) => [d, 3000] as const);
    const rr = runRateSeries(sparse([...spikes, [364, 0]]), 30).map((p) => p.cost);
    // A 30-day window holds at most one spike, so the run-rate tops out at 3000/30,
    // never anywhere near the $3000 spike that produced the old phantom ceiling.
    expect(Math.max(...rr)).toBeCloseTo(100, 6);
  });

  it('returns a single amortized point when the span is shorter than the window', () => {
    // 10-day span with one $400 spike → $40/day average, NOT a $400 band edge.
    const rr = runRateSeries(sparse([[0, 400], [9, 0]]), 30);
    expect(rr).toHaveLength(1);
    expect(rr[0]?.cost).toBeCloseTo(40, 6);
  });

  it('returns an empty series for empty history', () => {
    expect(runRateSeries([], 30)).toEqual([]);
  });
});
