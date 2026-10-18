import { describe, expect, it, vi } from 'vitest';
import type { SyncLogLine } from '@costgoblin/core';

/** The Data & Sync activity log: a bounded, in-memory ring buffer with live
 *  subscribers. Module state, so each case loads a fresh copy. */

async function freshLog(): Promise<typeof import('../main/sync-log.js')> {
  vi.resetModules();
  return import('../main/sync-log.js');
}

describe('sync activity log', () => {
  it('numbers each line and pushes it to every subscriber until they unsubscribe', async () => {
    const log = await freshLog();
    const a: SyncLogLine[] = [];
    const b: SyncLogLine[] = [];
    const offA = log.onSyncLogAppend(line => { a.push(line); });
    log.onSyncLogAppend(line => { b.push(line); });

    log.recordSyncLog('info', 'Auto-sync: checking', 1000);
    offA();
    log.recordSyncLog('warn', '[aws] retrying GET', 2000);

    expect(a).toEqual([{ seq: 0, ts: 1000, level: 'info', message: 'Auto-sync: checking' }]);
    expect(b.map(l => l.seq)).toEqual([0, 1]);
    expect(log.snapshotSyncLog()).toEqual([...b]);
  });

  it('stamps a line with the current time when none is given', async () => {
    const log = await freshLog();
    const before = Date.now();

    log.recordSyncLog('error', 'sync failed');

    const [line] = log.snapshotSyncLog();
    expect(line?.ts).toBeGreaterThanOrEqual(before);
    expect(line?.ts).toBeLessThanOrEqual(Date.now());
  });

  it('returns a snapshot the caller cannot use to change the log', async () => {
    const log = await freshLog();
    log.recordSyncLog('info', 'one', 1);

    const snapshot = log.snapshotSyncLog();
    expect(snapshot).toHaveLength(1);
    log.recordSyncLog('info', 'two', 2);

    expect(snapshot).toHaveLength(1);
    expect(log.snapshotSyncLog()).toHaveLength(2);
  });

  it('keeps only the newest 1000 lines', async () => {
    const log = await freshLog();
    for (let i = 0; i < 1005; i++) log.recordSyncLog('info', `line ${String(i)}`, i);

    const lines = log.snapshotSyncLog();
    expect(lines).toHaveLength(1000);
    expect(lines[0]?.message).toBe('line 5');
    expect(lines.at(-1)?.seq).toBe(1004);
  });

  it('clears the backlog without resetting the line numbering', async () => {
    const log = await freshLog();
    log.recordSyncLog('info', 'before', 1);

    log.clearSyncLog();
    expect(log.snapshotSyncLog()).toEqual([]);

    log.recordSyncLog('info', 'after', 2);
    expect(log.snapshotSyncLog()).toEqual([{ seq: 1, ts: 2, level: 'info', message: 'after' }]);
  });
});
