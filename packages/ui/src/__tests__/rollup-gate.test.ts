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
    expect(rollupGate(status, true, range).blocked).toBe(false);
  });

  it('does not block when idle (nothing is building)', () => {
    expect(rollupGate({ state: 'idle' }, false, range).blocked).toBe(false);
  });

  it('blocks a cold build when a selected month is still pending', () => {
    // June not yet built: periods completed-first, done=1 means only the first
    // entry (2026-05) is built; 2026-06 is in the pending tail.
    const status: RollupStatus = {
      state: 'computing', done: 1, total: 2,
      periods: ['2026-05', '2026-06'], active: ['2026-06'],
    };
    const gate = rollupGate(status, false, range);
    expect(gate.blocked).toBe(true);
    expect(gate.pendingMonths).toEqual(['2026-06']);
  });

  it('does not block once all selected months are built', () => {
    const status: RollupStatus = {
      state: 'computing', done: 2, total: 2,
      periods: ['2026-05', '2026-06'], active: [],
    };
    expect(rollupGate(status, false, range).blocked).toBe(false);
  });

  it('does not block a selected month outside the rebuild batch', () => {
    // Re-roll of an unrelated month; the viewed months are already valid.
    const status: RollupStatus = {
      state: 'computing', done: 0, total: 1,
      periods: ['2026-01'], active: ['2026-01'],
    };
    expect(rollupGate(status, false, range).blocked).toBe(false);
  });

  it('never blocks an incremental re-roll (everReady) — the badge handles it', () => {
    const status: RollupStatus = {
      state: 'computing', done: 0, total: 2,
      periods: ['2026-05', '2026-06'], active: ['2026-05'],
    };
    expect(rollupGate(status, true, range).blocked).toBe(false);
  });
});
