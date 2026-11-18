import { describe, it, expect } from 'vitest';
import type { SyncStatus } from '@costgoblin/core/browser';
import { noteSyncFinishes } from '../hooks/use-cost-optimization-syncs.js';

const SINCE = Date.parse('2026-11-19T12:00:00.000Z');
const BEFORE = new Date('2026-11-19T11:00:00.000Z');
const AFTER = new Date('2026-11-19T12:05:00.000Z');
const LATER = new Date('2026-11-19T12:10:00.000Z');

const RUNNING: SyncStatus = { status: 'syncing', phase: 'downloading', progress: 0, filesDone: 0, filesTotal: 2, bytesDone: 0, bytesTotal: 0, message: '' };

function done(at: Date, filesDownloaded = 1): SyncStatus {
  return { status: 'completed', lastSync: at, filesDownloaded };
}

describe('noteSyncFinishes', () => {
  it('on the first poll, counts a sync only when it finished after the data was read', () => {
    expect(noteSyncFinishes(null, [['a:cost-optimization', done(BEFORE)]], SINCE).downloaded).toBe(false);
    expect(noteSyncFinishes(null, [['a:cost-optimization', done(AFTER)]], SINCE).downloaded).toBe(true);
    expect(noteSyncFinishes(null, [['a:cost-optimization', RUNNING]], SINCE).downloaded).toBe(false);
  });

  it('counts a new finish time on any provider, and keeps the time a running sync had', () => {
    const first = noteSyncFinishes(null, [['a:cost-optimization', done(BEFORE)], ['b:cost-optimization', { status: 'idle', lastSync: null }]], SINCE);
    const running = noteSyncFinishes(first.seen, [['a:cost-optimization', RUNNING], ['b:cost-optimization', { status: 'idle', lastSync: null }]], SINCE);
    expect(running.downloaded).toBe(false);
    expect(running.seen.get('a:cost-optimization')).toBe(BEFORE.getTime());

    const finished = noteSyncFinishes(running.seen, [['a:cost-optimization', done(BEFORE)], ['b:cost-optimization', done(LATER)]], SINCE);
    expect(finished.downloaded).toBe(true);
    expect(noteSyncFinishes(finished.seen, [['a:cost-optimization', done(BEFORE)], ['b:cost-optimization', done(LATER)]], SINCE).downloaded).toBe(false);
  });

  it('ignores a sync that downloaded nothing, failed or was cancelled', () => {
    const first = noteSyncFinishes(null, [['a:cost-optimization', done(BEFORE)]], SINCE);
    expect(noteSyncFinishes(first.seen, [['a:cost-optimization', done(LATER, 0)]], SINCE).downloaded).toBe(false);
    expect(noteSyncFinishes(first.seen, [['a:cost-optimization', { status: 'failed', error: new Error('expired'), lastSync: LATER }]], SINCE).downloaded).toBe(false);
    expect(noteSyncFinishes(first.seen, [['a:cost-optimization', { status: 'idle', lastSync: LATER }]], SINCE).downloaded).toBe(false);
  });
});
