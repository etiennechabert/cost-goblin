import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@costgoblin/core';
import type { SyncLogLevel, SyncProgress } from '@costgoblin/core';
import { CANCEL_RESEND_MS, CLIENT_TERMINATED_MESSAGE, createDuckDBClient, drainDuckDBClientsSync, TERMINATE_GRACE_MS } from '../main/duckdb-client.js';
import { createSyncClient } from '../main/sync-client.js';
import type { SyncOptions } from '../main/sync-client.js';
import { initWorkerLifecycle } from '../main/worker-lifecycle.js';

/** The main-process side of the worker-thread protocol — spawn/ready
 *  handshake, crash handling, and the DuckDB and sync clients' message
 *  routing — against an in-process stand-in for node:worker_threads' Worker
 *  that the test drives by emitting the worker's messages itself. */

interface FakeWorker {
  readonly path: string;
  readonly options: unknown;
  readonly posted: unknown[];
  terminateCalls: number;
  failTerminate: boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

const threads = vi.hoisted(() => {
  const created: FakeWorker[] = [];
  return { created };
});

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    readonly path: string;
    readonly options: unknown;
    readonly posted: unknown[] = [];
    terminateCalls = 0;
    failTerminate = false;
    constructor(path: string, options?: unknown) {
      super();
      this.path = path;
      this.options = options;
      threads.created.push(this);
    }
    postMessage(msg: unknown): void { this.posted.push(msg); }
    terminate(): Promise<number> {
      this.terminateCalls += 1;
      return this.failTerminate ? Promise.reject(new Error('already gone')) : Promise.resolve(0);
    }
  }
  return { Worker };
});

function lastWorker(): FakeWorker {
  const worker = threads.created.at(-1);
  if (worker === undefined) throw new Error('no worker was spawned');
  return worker;
}

const READY = { kind: 'ready' };

interface Pending { readonly reject: (err: Error) => void }
const isReady = (msg: unknown): boolean => typeof msg === 'object' && msg !== null && 'kind' in msg && msg.kind === 'ready';
const initErrorOf = (msg: unknown): string | null =>
  typeof msg === 'object' && msg !== null && 'fail' in msg && typeof msg.fail === 'string' ? msg.fail : null;

/** Has `promise` settled yet (after letting queued callbacks run)? */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => { setImmediate(resolve); });
  return settled;
}

beforeEach(() => {
  threads.created.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('initWorkerLifecycle', () => {
  it('passes workerData to the worker only when given', async () => {
    const plain = initWorkerLifecycle<Pending>('/w/plain.js', isReady, initErrorOf);
    lastWorker().emit('message', READY);
    await plain;
    expect(lastWorker().options).toBeUndefined();

    const withData = initWorkerLifecycle<Pending>('/w/data.js', isReady, initErrorOf, { sandbox: true });
    lastWorker().emit('message', READY);
    const state = await withData;
    expect(lastWorker()).toMatchObject({ path: '/w/data.js', options: { workerData: { sandbox: true } } });
    expect(state).toMatchObject({ nextId: 0, fatalError: null });
  });

  it('waits past unrelated messages for the ready handshake', async () => {
    const starting = initWorkerLifecycle<Pending>('/w.js', isReady, initErrorOf);
    lastWorker().emit('message', { kind: 'log', message: 'warming up' });
    expect(await isSettled(starting)).toBe(false);

    lastWorker().emit('message', READY);
    await expect(starting).resolves.toMatchObject({ fatalError: null });
  });

  it('rejects with the worker\'s init error and terminates it', async () => {
    const starting = initWorkerLifecycle<Pending>('/w.js', isReady, initErrorOf);
    lastWorker().emit('message', { fail: 'DuckDB failed to open: disk full' });

    await expect(starting).rejects.toThrow('DuckDB failed to open: disk full');
    expect(lastWorker().terminateCalls).toBe(1);
  });

  it('rejects when the worker errors before ready, even if terminating it fails too', async () => {
    const crashed = initWorkerLifecycle<Pending>('/w.js', isReady, initErrorOf);
    lastWorker().failTerminate = true;
    lastWorker().emit('error', new Error('Cannot find module duckdb.node'));
    await expect(crashed).rejects.toThrow('Cannot find module duckdb.node');
    expect(lastWorker().terminateCalls).toBe(1);

    const threw = initWorkerLifecycle<Pending>('/w.js', isReady, initErrorOf);
    lastWorker().emit('error', 'thrown string');
    await expect(threw).rejects.toThrow('thrown string');
  });

  it('fails every in-flight request when the worker errors after ready', async () => {
    const starting = initWorkerLifecycle<Pending>('/w.js', isReady, initErrorOf);
    lastWorker().emit('message', READY);
    const state = await starting;
    const rejected: Error[] = [];
    state.pending.set(1, { reject: (err) => { rejected.push(err); } });
    state.pending.set(2, { reject: (err) => { rejected.push(err); } });

    lastWorker().emit('error', 'segfault in worker');

    expect(rejected.map(e => e.message)).toEqual(['segfault in worker', 'segfault in worker']);
    expect(state.pending.size).toBe(0);
    expect(state.fatalError?.message).toBe('segfault in worker');
  });

  it('fails in-flight requests on an unexpected exit, keeping an earlier fatal error', async () => {
    const starting = initWorkerLifecycle<Pending>('/w.js', isReady, initErrorOf);
    lastWorker().emit('message', READY);
    const state = await starting;
    const rejected: string[] = [];
    state.pending.set(1, { reject: (err) => { rejected.push(err.message); } });

    lastWorker().emit('exit', 0);
    expect(rejected).toEqual([]);
    expect(state.fatalError).toBeNull();

    lastWorker().emit('exit', 3);
    expect(rejected).toEqual(['Worker exited unexpectedly with code 3']);
    expect(state.fatalError?.message).toBe('Worker exited unexpectedly with code 3');

    lastWorker().emit('error', new Error('out of memory'));
    lastWorker().emit('exit', 134);
    expect(state.fatalError?.message).toBe('out of memory');
  });
});

describe('createDuckDBClient', () => {
  async function connected(): Promise<{ client: Awaited<ReturnType<typeof createDuckDBClient>>; worker: FakeWorker }> {
    const creating = createDuckDBClient('/w/duckdb-worker.cjs');
    const worker = lastWorker();
    worker.emit('message', READY);
    return { client: await creating, worker };
  }

  it('posts each kind of query and resolves it with the rows the worker returns', async () => {
    const { client, worker } = await connected();
    const started: string[] = [];

    const plain = client.runQuery('SELECT 1', () => { started.push('plain'); });
    const build = client.runBuildQuery('COPY x TO y');
    const prepared = client.runPreparedQuery('SELECT $1', ['a']);

    expect(worker.posted).toEqual([
      { kind: 'query', id: 0, sql: 'SELECT 1' },
      { kind: 'query', id: 1, sql: 'COPY x TO y', fresh: true },
      { kind: 'prepared-query', id: 2, sql: 'SELECT $1', params: ['a'] },
    ]);

    worker.emit('message', { kind: 'started', id: 0 });
    worker.emit('message', { kind: 'started', id: 1 });
    expect(started).toEqual(['plain']);

    worker.emit('message', { kind: 'rows', id: 0, rows: [{ n: 1 }] });
    worker.emit('message', { kind: 'rows', id: 1, rows: [] });
    worker.emit('message', { kind: 'error', id: 2, message: 'Binder Error: no such column' });
    await expect(plain).resolves.toEqual([{ n: 1 }]);
    await expect(build).resolves.toEqual([]);
    await expect(prepared).rejects.toThrow('Binder Error: no such column');
  });

  it('ignores malformed messages and answers for requests it never sent', async () => {
    const { client, worker } = await connected();
    const query = client.runQuery('SELECT 2');

    for (const msg of [
      null,
      'rows',
      { kind: 'rows', id: 0, rows: 'not rows' },
      { kind: 'error', id: 0 },
      { kind: 'started' },
      { kind: 'mystery', id: 0 },
      READY,
      { kind: 'started', id: 99 },
      { kind: 'rows', id: 99, rows: [] },
    ]) worker.emit('message', msg);
    expect(await isSettled(query)).toBe(false);

    worker.emit('message', { kind: 'rows', id: 0, rows: [{ ok: true }] });
    await expect(query).resolves.toEqual([{ ok: true }]);
  });

  it('forwards cancellation and configuration, and terminates the worker', async () => {
    const { client, worker } = await connected();

    client.cancelPendingQueries();
    client.configure({ tempDir: '/tmp/duck', memoryGB: 4, threads: 2 });
    await client.terminate();

    expect(worker.posted).toEqual([
      { kind: 'cancel-pending' },
      { kind: 'configure', tempDir: '/tmp/duck', memoryGB: 4, threads: 2 },
    ]);
    expect(worker.terminateCalls).toBe(1);
  });

  // Tearing the thread down under a running query aborts the process hosting
  // it (duckdb-terminate.test.ts), so terminate() first empties the worker.
  describe('terminate with queries in flight', () => {
    const CANCELLED = { kind: 'error', message: 'Query cancelled' };
    const cancelsPosted = (worker: FakeWorker): number =>
      worker.posted.filter(msg => JSON.stringify(msg) === JSON.stringify({ kind: 'cancel-pending' })).length;

    it('cancels them and ends the worker only once every one has answered', async () => {
      const { client, worker } = await connected();
      const first = expect(client.runQuery('SELECT slow')).rejects.toThrow('Query cancelled');
      const second = expect(client.runPreparedQuery('SELECT $1', [1])).resolves.toEqual([]);

      const terminating = client.terminate();
      expect(worker.posted.at(-1)).toEqual({ kind: 'cancel-pending' });

      worker.emit('message', { ...CANCELLED, id: 0 });
      expect(await isSettled(terminating)).toBe(false);
      expect(worker.terminateCalls).toBe(0);

      // The second one finished before its cancel landed: rows end the wait too.
      worker.emit('message', { kind: 'rows', id: 1, rows: [] });
      await terminating;
      expect(worker.terminateCalls).toBe(1);
      await first;
      await second;
    });

    it('re-sends the cancel until the queries answer, then stops', async () => {
      const { client, worker } = await connected();
      vi.useFakeTimers();
      const query = expect(client.runQuery('SELECT slow')).rejects.toThrow('Query cancelled');

      const terminating = client.terminate();
      expect(cancelsPosted(worker)).toBe(1);
      await vi.advanceTimersByTimeAsync(CANCEL_RESEND_MS * 3);
      expect(cancelsPosted(worker)).toBe(4);

      worker.emit('message', { ...CANCELLED, id: 0 });
      await terminating;
      await query;
      await vi.advanceTimersByTimeAsync(CANCEL_RESEND_MS * 3);
      expect(cancelsPosted(worker)).toBe(4);
      expect(vi.getTimerCount()).toBe(0);
      expect(worker.terminateCalls).toBe(1);
    });

    it('stops waiting after the grace period, and still ends the worker only once the query settles', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const { client, worker } = await connected();
      vi.useFakeTimers();
      const query = expect(client.runQuery('SELECT stuck')).resolves.toEqual([{ n: 1 }]);

      const terminating = client.terminate();
      await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS - 1);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await terminating;
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ inFlight: 1, graceMs: TERMINATE_GRACE_MS });

      // The caller has moved on; the thread is left alone while it is busy...
      await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS);
      expect(worker.terminateCalls).toBe(0);
      expect(cancelsPosted(worker)).toBeGreaterThan(TERMINATE_GRACE_MS / CANCEL_RESEND_MS);

      // ...and torn down the moment it no longer is. A failure there has no
      // caller left to reach, so it is logged rather than left unhandled.
      worker.failTerminate = true;
      worker.emit('message', { kind: 'rows', id: 0, rows: [{ n: 1 }] });
      await vi.advanceTimersByTimeAsync(0);
      await query;
      expect(worker.terminateCalls).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ends the wait when the worker dies by itself', async () => {
      const { client, worker } = await connected();
      const crashed = expect(client.runQuery('SELECT slow')).rejects.toThrow('Worker exited unexpectedly with code 1');
      const terminating = client.terminate();
      worker.emit('exit', 1);
      await terminating;
      await crashed;
      expect(worker.terminateCalls).toBe(1);

      // A clean exit leaves the query unanswered, but there is no thread left to protect.
      const second = await connected();
      void second.client.runQuery('SELECT slow');
      const secondTerminating = second.client.terminate();
      second.worker.emit('exit', 0);
      await secondTerminating;
      expect(second.worker.terminateCalls).toBe(1);
    });

    it('reports a failure to end the worker to the caller still waiting for it', async () => {
      const { client, worker } = await connected();
      worker.failTerminate = true;
      const query = expect(client.runQuery('SELECT slow')).rejects.toThrow('Query cancelled');
      const terminating = expect(client.terminate()).rejects.toThrow('already gone');
      worker.emit('message', { ...CANCELLED, id: 0 });
      await terminating;
      await query;
    });
  });

  it('refuses queries once terminated, and ends the worker once however often it is asked', async () => {
    const { client, worker } = await connected();

    await Promise.all([client.terminate(), client.terminate()]);
    await client.terminate();
    expect(worker.terminateCalls).toBe(1);

    await expect(client.runQuery('SELECT 1')).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);
    await expect(client.runBuildQuery('SELECT 1')).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);
    expect(worker.posted).toEqual([]);
  });

  it('rejects new queries at once after the worker has crashed', async () => {
    const { client, worker } = await connected();
    const inFlight = client.runQuery('SELECT 3');

    worker.emit('error', new Error('worker crashed'));

    await expect(inFlight).rejects.toThrow('worker crashed');
    await expect(client.runQuery('SELECT 4')).rejects.toThrow('worker crashed');
    expect(worker.posted).toHaveLength(1);
  });

  it('fails creation on the worker\'s init error, but not on a stray error before ready', async () => {
    const failing = createDuckDBClient('/w/duckdb-worker.cjs', { sandbox: { allowedDirectories: ['/data'], allowedPaths: [], tempDirectory: '/tmp/duck', memoryLimitGB: 1, threads: 1 } });
    lastWorker().emit('message', { kind: 'error', id: -1, message: 'sandbox could not be applied' });
    await expect(failing).rejects.toThrow('sandbox could not be applied');

    const recovering = createDuckDBClient('/w/duckdb-worker.cjs');
    lastWorker().emit('message', 'noise');
    lastWorker().emit('message', { kind: 'error', id: 7, message: 'late answer' });
    lastWorker().emit('message', READY);
    await expect(recovering).resolves.toBeDefined();
  });
});

// The exit drain's bookkeeping, against a stand-in worker whose settled counter
// the test moves itself. duckdb-drain.test.ts runs the same against real queries.
describe('drainDuckDBClientsSync', () => {
  interface Counted {
    readonly client: Awaited<ReturnType<typeof createDuckDBClient>>;
    readonly worker: FakeWorker;
    /** The worker's side of the counter: how many requests it has settled. */
    readonly settle: (count: number) => void;
  }

  async function counted(): Promise<Counted> {
    const settled = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cells = new Int32Array(settled);
    const creating = createDuckDBClient('/w/duckdb-worker.cjs');
    const worker = lastWorker();
    worker.emit('message', { kind: 'ready', settled });
    return { client: await creating, worker, settle: (count) => { Atomics.store(cells, 0, count); } };
  }

  /** A stand-in worker never exits by itself, and a live client is waited on. */
  function gone(worker: FakeWorker): void {
    worker.emit('exit', 0);
  }

  const DRAIN = { kind: 'drain' };
  const isDrain = (msg: unknown): boolean => JSON.stringify(msg) === JSON.stringify(DRAIN);

  it('waits until the worker has settled as many requests as were posted', async () => {
    const { client, worker, settle } = await counted();
    const queries = [client.runQuery('SELECT 1'), client.runBuildQuery('COPY x TO y'), client.runPreparedQuery('SELECT $1', ['a'])];
    for (const query of queries) query.catch(() => undefined);
    client.configure({ memoryGB: 4 });

    // Four posted, three settled: one is still in flight at the deadline.
    settle(3);
    expect(drainDuckDBClientsSync(20)).toBe(false);
    settle(4);
    expect(drainDuckDBClientsSync(20)).toBe(true);

    // Asked to drain once, however often it is waited on.
    expect(worker.posted.filter(isDrain)).toHaveLength(1);
    expect(worker.posted.at(-1)).toEqual(DRAIN);
    gone(worker);
  });

  it('is settled from the start when nothing was posted', async () => {
    const { worker } = await counted();

    expect(drainDuckDBClientsSync(0)).toBe(true);
    expect(worker.posted).toEqual([DRAIN]);
    gone(worker);
  });

  it('starts no query once it is draining', async () => {
    const { client, worker } = await counted();
    drainDuckDBClientsSync(0);

    await expect(client.runQuery('SELECT 1')).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);
    await expect(client.runBuildQuery('COPY x TO y')).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);
    await expect(client.runPreparedQuery('SELECT $1', ['a'])).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);

    expect(worker.posted).toEqual([DRAIN]);
    gone(worker);
  });

  it('no longer waits on a worker that exited', async () => {
    const { client, worker } = await counted();
    client.runQuery('SELECT 1').catch(() => undefined);
    expect(drainDuckDBClientsSync(0)).toBe(false);

    worker.emit('exit', 1);

    expect(drainDuckDBClientsSync(0)).toBe(true);
  });

  it('asks nothing of a worker that shares no counter, and does not wait on it', async () => {
    const creating = createDuckDBClient('/w/duckdb-worker.cjs');
    const worker = lastWorker();
    worker.emit('message', READY);
    const client = await creating;
    client.runQuery('SELECT 1').catch(() => undefined);

    expect(drainDuckDBClientsSync(0)).toBe(true);

    expect(worker.posted.filter(isDrain)).toHaveLength(0);
    gone(worker);
  });
});

describe('createSyncClient', () => {
  const OPTIONS: SyncOptions = {
    bucketPath: 's3://billing/focus/',
    auth: { kind: 'aws-profile', profile: 'billing' },
    providerName: 'aws-main',
    dataDir: '/data',
    files: [{ key: 'a.parquet', contentHash: 'h', size: 1 }],
    syncKey: 'aws-main:daily',
  };

  async function connected(onLog?: (level: SyncLogLevel, message: string, ts: number) => void): Promise<{ client: Awaited<ReturnType<typeof createSyncClient>>; worker: FakeWorker }> {
    const creating = createSyncClient('/w/sync-worker.cjs', onLog);
    const worker = lastWorker();
    worker.emit('message', READY);
    return { client: await creating, worker };
  }

  it('posts the sync request, defaulting the tier to daily', async () => {
    const { client, worker } = await connected();

    const sync = client.syncPeriods(OPTIONS);

    expect(worker.posted).toEqual([{
      kind: 'sync', id: 0, bucketPath: 's3://billing/focus/', auth: { kind: 'aws-profile', profile: 'billing' },
      providerName: 'aws-main', dataDir: '/data', tier: 'daily', files: OPTIONS.files,
    }]);
    worker.emit('message', { kind: 'complete', id: 0, filesDownloaded: 1, rowsProcessed: 120 });
    await expect(sync).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 120 });
  });

  it('relays progress through every phase, passing on only the fields the worker sent', async () => {
    const { client, worker } = await connected();
    const progress: SyncProgress[] = [];

    const sync = client.syncPeriods({ ...OPTIONS, tier: 'hourly', onProgress: (p) => { progress.push(p); } });
    worker.emit('message', { kind: 'progress', id: 0, phase: 'downloading', filesDone: 0, filesTotal: 2, bytesDone: 512, bytesTotal: 2048, message: 'a.parquet' });
    worker.emit('message', { kind: 'progress', id: 0, phase: 'repartitioning', filesDone: 2, filesTotal: 2 });
    worker.emit('message', { kind: 'progress', id: 0, phase: 'done', filesDone: 2, filesTotal: 2 });
    worker.emit('message', { kind: 'complete', id: 0, filesDownloaded: 2, rowsProcessed: 10 });
    await sync;

    expect(progress).toEqual([
      { phase: 'downloading', filesTotal: 2, filesDone: 0, bytesDone: 512, bytesTotal: 2048, message: 'a.parquet' },
      { phase: 'repartitioning', filesTotal: 2, filesDone: 2 },
      { phase: 'done', filesTotal: 2, filesDone: 2 },
    ]);
    expect(worker.posted).toEqual([expect.objectContaining({ kind: 'sync', tier: 'hourly' })]);
  });

  it('rejects with the worker\'s error, and frees the key for a new sync', async () => {
    const { client, worker } = await connected();

    const failed = client.syncPeriods(OPTIONS);
    worker.emit('message', { kind: 'error', id: 0, message: 'AccessDenied: s3:GetObject' });
    await expect(failed).rejects.toThrow('AccessDenied: s3:GetObject');

    const retried = client.syncPeriods(OPTIONS);
    worker.emit('message', { kind: 'complete', id: 1, filesDownloaded: 0, rowsProcessed: 0 });
    await expect(retried).resolves.toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
  });

  it('streams worker log lines to the sink, whatever request is running', async () => {
    const lines: [SyncLogLevel, string, number][] = [];
    const { worker } = await connected((level, message, ts) => { lines.push([level, message, ts]); });

    worker.emit('message', { kind: 'log', level: 'info', message: '[aws] GET a.parquet', ts: 1_700_000_000_000 });
    worker.emit('message', { kind: 'log', level: 'warn', message: 'missing ts' });

    expect(lines).toEqual([['info', '[aws] GET a.parquet', 1_700_000_000_000]]);
  });

  it('drops log lines when no sink is attached, and progress when no listener is', async () => {
    const { client, worker } = await connected();
    const sync = client.syncPeriods(OPTIONS);

    worker.emit('message', { kind: 'log', level: 'info', message: 'nobody listening', ts: 1 });
    worker.emit('message', { kind: 'progress', id: 0, phase: 'downloading', filesDone: 0, filesTotal: 1 });
    worker.emit('message', { kind: 'complete', id: 0, filesDownloaded: 1, rowsProcessed: 1 });

    await expect(sync).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 1 });
  });

  it('ignores malformed messages and answers for requests it never sent', async () => {
    const { client, worker } = await connected();
    const progress: SyncProgress[] = [];
    const sync = client.syncPeriods({ ...OPTIONS, onProgress: (p) => { progress.push(p); } });

    for (const msg of [
      42,
      { kind: 'progress', id: 0, phase: 'unzipping', filesDone: 0, filesTotal: 1 },
      { kind: 'progress', id: 0, phase: 'downloading', filesDone: '0', filesTotal: 1 },
      { kind: 'progress', id: 0, phase: 'downloading', filesDone: 0 },
      { kind: 'complete', id: 0, filesDownloaded: 1 },
      { kind: 'error', id: 0 },
      { kind: 'complete', filesDownloaded: 1, rowsProcessed: 1 },
      { kind: 'unknown', id: 0 },
      READY,
      { kind: 'complete', id: 9, filesDownloaded: 1, rowsProcessed: 1 },
    ]) worker.emit('message', msg);
    expect(await isSettled(sync)).toBe(false);
    expect(progress).toEqual([]);

    worker.emit('message', { kind: 'complete', id: 0, filesDownloaded: 1, rowsProcessed: 5 });
    await expect(sync).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 5 });
  });

  it('rejects new syncs at once after the worker has crashed', async () => {
    const { client, worker } = await connected();

    worker.emit('exit', 1);

    await expect(client.syncPeriods(OPTIONS)).rejects.toThrow('Worker exited unexpectedly with code 1');
    expect(worker.posted).toEqual([]);
  });

  it('fails creation on the worker\'s init error, but not on a stray error before ready', async () => {
    const failing = createSyncClient('/w/sync-worker.cjs');
    lastWorker().emit('message', { kind: 'error', id: -1, message: 'cannot load the AWS SDK' });
    await expect(failing).rejects.toThrow('cannot load the AWS SDK');

    const recovering = createSyncClient('/w/sync-worker.cjs');
    lastWorker().emit('message', null);
    lastWorker().emit('message', { kind: 'error', id: 3, message: 'late answer' });
    lastWorker().emit('message', READY);
    const client = await recovering;
    await client.terminate();
    expect(lastWorker().terminateCalls).toBe(1);
  });
});
