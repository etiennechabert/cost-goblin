import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryLog, originStore } from '../main/query-log.js';
import type { RawRow } from '../main/duckdb-client.js';

/** The Debug view's query log: per-query lifecycle, the bounded history, and
 *  the wrappers that instrument the DuckDB client's query functions. */

const T0 = new Date('2026-10-01T09:00:00.000Z');

function entry(log: QueryLog, id: number): ReturnType<QueryLog['getEntries']>[number] {
  const found = log.getEntries().find(e => e.id === id);
  if (found === undefined) throw new Error(`no log entry ${String(id)}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QueryLog lifecycle', () => {
  it('follows a query from queued to running to success, with its duration and row count', () => {
    const log = new QueryLog();

    const id = log.start('SELECT 1', ['a', 'b'], true);
    expect(entry(log, id)).toEqual({
      id, sql: 'SELECT 1', paramCount: 2, status: 'queued', startedAt: T0.getTime(),
      durationMs: null, rowCount: null, error: null, materialized: true, cached: false, origin: null,
    });

    log.markRunning(id);
    expect(entry(log, id).status).toBe('running');

    vi.setSystemTime(T0.getTime() + 250);
    log.complete(id, 42, true);
    expect(entry(log, id)).toMatchObject({ status: 'success', durationMs: 250, rowCount: 42, cached: true });

    // A late "started" notice can't drag a finished query back to running.
    log.markRunning(id);
    expect(entry(log, id).status).toBe('success');
  });

  it('records a failure with its message and duration', () => {
    const log = new QueryLog();
    const id = log.start('SELECT nope', []);

    vi.setSystemTime(T0.getTime() + 40);
    log.fail(id, 'Binder Error: column "nope" not found');

    expect(entry(log, id)).toMatchObject({ status: 'error', durationMs: 40, error: 'Binder Error: column "nope" not found', materialized: false });
  });

  it('ignores updates for queries it no longer (or never) tracked', () => {
    const log = new QueryLog();
    log.start('SELECT 1', []);
    const before = log.getEntries();

    log.markRunning(99);
    log.complete(99, 1);
    log.fail(99, 'gone');

    expect(log.getEntries()).toEqual(before);
    expect(log.getEntryForExplain(99)).toBeUndefined();
  });

  it('tags each query with the origin of the IPC call that ran it', () => {
    const log = new QueryLog();

    const id = originStore.run('pie:service', () => log.start('SELECT 2', []));

    expect(entry(log, id).origin).toBe('pie:service');
    expect(entry(log, log.start('SELECT 3', [])).origin).toBeNull();
  });

  it('keeps the SQL and bound params for EXPLAIN, without exposing params in the listing', () => {
    const log = new QueryLog();
    const id = log.start('SELECT * FROM t WHERE a = $1', ['2026-01-01']);

    expect(log.getEntryForExplain(id)).toEqual({ sql: 'SELECT * FROM t WHERE a = $1', params: ['2026-01-01'] });
    expect('params' in entry(log, id)).toBe(false);
  });
});

describe('QueryLog history', () => {
  it('keeps only the 200 most recent queries', () => {
    const log = new QueryLog();
    for (let i = 0; i < 205; i++) log.start(`SELECT ${String(i)}`, []);

    const entries = log.getEntries();
    expect(entries).toHaveLength(200);
    expect(entries[0]?.sql).toBe('SELECT 5');
    expect(entries.at(-1)?.sql).toBe('SELECT 204');
  });

  it('clearCompleted keeps the queued and running queries; clear drops everything', () => {
    const log = new QueryLog();
    const done = log.start('done', []);
    const failed = log.start('failed', []);
    const running = log.start('running', []);
    log.start('queued', []);
    log.complete(done, 1);
    log.fail(failed, 'x');
    log.markRunning(running);

    log.clearCompleted();
    expect(log.getEntries().map(e => e.sql)).toEqual(['running', 'queued']);

    log.clear();
    expect(log.getEntries()).toEqual([]);
  });
});

describe('QueryLog wrappers', () => {
  it('wrapQuery logs a query through to its row count', async () => {
    const log = new QueryLog();
    const statusesSeen: string[] = [];
    const run = log.wrapQuery((sql, onStarted) => {
      statusesSeen.push(entry(log, 0).status);
      onStarted?.();
      statusesSeen.push(entry(log, 0).status);
      return Promise.resolve<RawRow[]>([{ sql }, { sql }]);
    });

    await expect(run('SELECT 1')).resolves.toEqual([{ sql: 'SELECT 1' }, { sql: 'SELECT 1' }]);
    expect(statusesSeen).toEqual(['queued', 'running']);
    expect(entry(log, 0)).toMatchObject({ status: 'success', rowCount: 2, paramCount: 0 });
  });

  it('wrapQuery logs a failure and still rejects with it', async () => {
    const log = new QueryLog();
    const failing = log.wrapQuery(() => Promise.reject(new Error('IO Error: no such file')));
    await expect(failing('SELECT 1')).rejects.toThrow('IO Error: no such file');
    expect(entry(log, 0)).toMatchObject({ status: 'error', error: 'IO Error: no such file' });

    const throwsText = log.wrapQuery(vi.fn<(sql: string) => Promise<RawRow[]>>().mockRejectedValue('worker gone'));
    await expect(throwsText('SELECT 2')).rejects.toBe('worker gone');
    expect(entry(log, 1)).toMatchObject({ status: 'error', error: 'worker gone' });
  });

  it('wrapPreparedQuery logs the param count and whether the rollup served it', async () => {
    const log = new QueryLog();
    const seenParams: (readonly unknown[])[] = [];
    const run = log.wrapPreparedQuery((_sql, params, onStarted) => {
      seenParams.push(params);
      onStarted?.();
      return Promise.resolve<RawRow[]>([]);
    });

    await run('SELECT $1', ['x'], true);
    await run('SELECT $1, $2', ['x', 'y']);

    expect(seenParams).toEqual([['x'], ['x', 'y']]);
    expect(log.getEntries().map(e => [e.paramCount, e.materialized, e.status, e.rowCount])).toEqual([
      [1, true, 'success', 0],
      [2, false, 'success', 0],
    ]);
  });

  it('wrapPreparedQuery logs a failure and still rejects with it', async () => {
    const log = new QueryLog();
    const failing = log.wrapPreparedQuery(vi.fn<(sql: string, params: readonly unknown[]) => Promise<RawRow[]>>().mockRejectedValue(new Error('Conversion Error')));
    await expect(failing('SELECT $1', [1])).rejects.toThrow('Conversion Error');

    const throwsText = log.wrapPreparedQuery(vi.fn<(sql: string, params: readonly unknown[]) => Promise<RawRow[]>>().mockRejectedValue('cancelled'));
    await expect(throwsText('SELECT $1', [2])).rejects.toBe('cancelled');

    expect(log.getEntries().map(e => e.error)).toEqual(['Conversion Error', 'cancelled']);
  });
});
