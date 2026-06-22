import { describe, it, expect } from 'vitest';
import { MaterializedBase, awaitWithTimeout } from '../main/materialized-base.js';

const RANGE = { start: '2026-01-01', end: '2026-03-01' };

describe('awaitWithTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    let settled = false;
    const p = new Promise<void>((resolve) => { setTimeout(() => { settled = true; resolve(); }, 10); });
    await awaitWithTimeout(p, 1000);
    expect(settled).toBe(true);
  });

  it('resolves at the timeout when the promise hangs', async () => {
    const start = Date.now();
    await awaitWithTimeout(new Promise<void>(() => { /* never resolves */ }), 40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('does not reject when the awaited promise rejects', async () => {
    await expect(awaitWithTimeout(Promise.reject(new Error('boom')), 1000)).resolves.toBeUndefined();
  });
});

describe('MaterializedBase', () => {
  it('is not ready until materialize resolves, then ready', async () => {
    const mb = new MaterializedBase();
    expect(mb.isReady()).toBe(false);
    await mb.materialize(() => Promise.resolve([]), 'CREATE OR REPLACE TABLE cost_base AS SELECT 1', RANGE, 'daily', 'h1');
    expect(mb.isReady()).toBe(true);
  });

  it('getSource returns cost_base only for a range within the window and matching tier', async () => {
    const mb = new MaterializedBase();
    await mb.materialize(() => Promise.resolve([]), 'sql', RANGE, 'daily', 'h1');
    expect(mb.getSource({ start: '2026-01-15', end: '2026-02-15' }, 'daily')).toBe('cost_base');
    expect(mb.getSource({ start: '2025-12-01', end: '2026-02-15' }, 'daily')).toBeUndefined(); // starts before window
    expect(mb.getSource({ start: '2026-01-15', end: '2026-04-01' }, 'daily')).toBeUndefined(); // ends after window
    expect(mb.getSource({ start: '2026-01-15', end: '2026-02-15' }, 'hourly')).toBeUndefined(); // wrong tier
  });

  it('stays not ready when the materialize query fails', async () => {
    const mb = new MaterializedBase();
    await mb.materialize(() => Promise.reject(new Error('boom')), 'sql', RANGE, 'daily', 'h1');
    expect(mb.isReady()).toBe(false);
  });

  it('whenReady-style gating: awaitWithTimeout(pending) then isReady() reflects success', async () => {
    const mb = new MaterializedBase();
    // Kick off a slow materialize and gate on it the way AppContext.awaitWarmup does.
    const pending = mb.materialize(
      () => new Promise((resolve) => { setTimeout(() => { resolve([]); }, 20); }),
      'sql', RANGE, 'daily', 'h1',
    );
    await awaitWithTimeout(pending, 1000);
    expect(mb.isReady()).toBe(true);
  });
});
