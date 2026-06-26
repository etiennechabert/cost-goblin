import { describe, it, expect } from 'vitest';
import type { RollupStatus } from '@costgoblin/core/browser';
import { monthsInRange } from '../lib/dates.js';
import { rollupGate } from '../lib/rollup-gate.js';

describe('monthsInRange', () => {
  it('returns every YYYY-MM a range spans, inclusive', () => {
    expect(monthsInRange({ start: '2026-03-15', end: '2026-05-20' })).toEqual(['2026-03', '2026-04', '2026-05']);
  });
  it('returns a single month for an intra-month range', () => {
    expect(monthsInRange({ start: '2026-06-01', end: '2026-06-24' })).toEqual(['2026-06']);
  });
  it('crosses a year boundary', () => {
    expect(monthsInRange({ start: '2025-12-20', end: '2026-01-05' })).toEqual(['2025-12', '2026-01']);
  });
  it('returns [] for an inverted range', () => {
    expect(monthsInRange({ start: '2026-06-01', end: '2026-05-01' })).toEqual([]);
  });
});

const range = { start: '2026-05-25', end: '2026-06-24' }; // spans 2026-05, 2026-06

describe('rollupGate', () => {
  it('does not block when the rollup is ready', () => {
    const status: RollupStatus = { state: 'ready', periods: 13 };
    expect(rollupGate(status, range).blocked).toBe(false);
  });

  it('does not block when idle (nothing is building)', () => {
    expect(rollupGate({ state: 'idle' }, range).blocked).toBe(false);
  });

  it('blocks a cleared/cold build — every month pending, viewed months unbuilt', () => {
    // Clear-cache rebuild: done=0, the whole history is in the batch, nothing
    // built yet → both viewed months are in the pending tail.
    const status: RollupStatus = {
      state: 'computing', done: 0, total: 13,
      periods: ['2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12', '2025-11', '2025-10', '2025-09', '2025-08', '2025-07', '2025-06'],
      active: ['2026-06', '2026-05'],
    };
    const gate = rollupGate(status, range);
    expect(gate.blocked).toBe(true);
    expect(gate.pendingMonths).toEqual(['2026-05', '2026-06']);
  });

  it('blocks while a single viewed month is still pending', () => {
    // periods completed-first, done=1 → only 2026-05 built; 2026-06 pending.
    const status: RollupStatus = {
      state: 'computing', done: 1, total: 2,
      periods: ['2026-05', '2026-06'], active: ['2026-06'],
    };
    const gate = rollupGate(status, range);
    expect(gate.blocked).toBe(true);
    expect(gate.pendingMonths).toEqual(['2026-06']);
  });

  it('does not block once all selected months are built', () => {
    const status: RollupStatus = {
      state: 'computing', done: 2, total: 2,
      periods: ['2026-05', '2026-06'], active: [],
    };
    expect(rollupGate(status, range).blocked).toBe(false);
  });

  it('does not block a re-roll of months the user is not viewing (badge handles it)', () => {
    // Only an unrelated month is rebuilding; the viewed months stay valid in
    // the rollup (not in the batch at all), so they are still served.
    const status: RollupStatus = {
      state: 'computing', done: 0, total: 1,
      periods: ['2026-01'], active: ['2026-01'],
    };
    expect(rollupGate(status, range).blocked).toBe(false);
  });
});
