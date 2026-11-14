import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { QUERY_CANCELLED_MESSAGE } from '@costgoblin/core';
import { createDuckDBClient, drainDuckDBClientsSync } from '../main/duckdb-client.js';
import type { DuckDBClient } from '../main/duckdb-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', '..', 'out', 'worker', 'duckdb-worker.cjs');

if (!existsSync(workerPath)) {
  throw new Error(
    `Worker bundle not found at ${workerPath}. Run "npm run build:worker" in packages/desktop first.`,
  );
}

// Minutes of work for DuckDB if nothing stops it: a test that passes in
// seconds proves the query was interrupted, not that it finished.
const ENDLESS_SQL = 'SELECT sum(a.range + b.range) AS total FROM range(300000) a, range(300000) b';

/** Far more than a drain needs (milliseconds), far less than the query takes. */
const DRAIN_BUDGET_MS = 20_000;

interface InFlight {
  /** Resolves once the worker has a connection for the query. */
  readonly started: Promise<void>;
  /** The query's outcome, as a message: its error's, or 'rows' if it finished. */
  readonly outcome: Promise<string>;
}

function inFlight(run: (onStarted: () => void) => Promise<unknown>): InFlight {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const outcome = run(markStarted).then(
    () => 'rows',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  return { started, outcome };
}

async function withClient(run: (client: DuckDBClient) => Promise<void>): Promise<void> {
  const client = await createDuckDBClient(workerPath);
  try {
    await run(client);
  } finally {
    await client.terminate();
  }
}

// Tearing a worker down (worker.terminate(), or the process exiting) while a
// DuckDB call is in flight aborts the whole process: the call's completion
// runs in an environment that can no longer take it, throws, and nothing
// catches it. These tests would not fail an assertion without the drain,
// they would take the test process down with them.
describe('DuckDB client drain', () => {
  it('settles a pooled query and a build that are in flight', async () => {
    await withClient(async (client) => {
      const pooled = inFlight(onStarted => client.runQuery(ENDLESS_SQL, onStarted));
      const build = inFlight(onStarted => client.runBuildQuery(ENDLESS_SQL, onStarted));
      await Promise.all([pooled.started, build.started]);

      const began = performance.now();
      expect(drainDuckDBClientsSync(DRAIN_BUDGET_MS)).toBe(true);
      expect(performance.now() - began).toBeLessThan(DRAIN_BUDGET_MS);

      expect(await pooled.outcome).toBe(QUERY_CANCELLED_MESSAGE);
      expect(await build.outcome).toBe(QUERY_CANCELLED_MESSAGE);
    });
  }, 60_000);

  it('settles queries the worker has not started yet', async () => {
    await withClient(async (client) => {
      // More than the pool holds, and none awaited: some are still queued for
      // a connection, some not even received by the worker.
      const queries = Array.from({ length: 8 }, () => inFlight(() => client.runPreparedQuery(ENDLESS_SQL, [])));

      expect(drainDuckDBClientsSync(DRAIN_BUDGET_MS)).toBe(true);

      expect(await Promise.all(queries.map(q => q.outcome))).toEqual(queries.map(() => QUERY_CANCELLED_MESSAGE));
    });
  }, 60_000);

  it('returns at once when nothing is in flight', async () => {
    await withClient(async (client) => {
      expect(await client.runQuery('SELECT 1 AS one')).toEqual([{ one: 1 }]);

      const began = performance.now();
      expect(drainDuckDBClientsSync(DRAIN_BUDGET_MS)).toBe(true);
      expect(performance.now() - began).toBeLessThan(1_000);
    });
  });

  it('refuses queries once it is draining', async () => {
    await withClient(async (client) => {
      drainDuckDBClientsSync(DRAIN_BUDGET_MS);

      await expect(client.runQuery('SELECT 1')).rejects.toThrow(QUERY_CANCELLED_MESSAGE);
      await expect(client.runBuildQuery('SELECT 1')).rejects.toThrow(QUERY_CANCELLED_MESSAGE);
      await expect(client.runPreparedQuery('SELECT 1', [])).rejects.toThrow(QUERY_CANCELLED_MESSAGE);
    });
  });

  it('gives up at the deadline and says so', async () => {
    await withClient(async (client) => {
      const query = inFlight(onStarted => client.runQuery(ENDLESS_SQL, onStarted));
      await query.started;

      // No time at all: the query cannot have settled yet.
      expect(drainDuckDBClientsSync(0)).toBe(false);
      // The cancel went out all the same.
      expect(await query.outcome).toBe(QUERY_CANCELLED_MESSAGE);
    });
  }, 60_000);

  it('no longer waits on a client that was terminated', async () => {
    const client = await createDuckDBClient(workerPath);
    await client.terminate();

    const began = performance.now();
    expect(drainDuckDBClientsSync(DRAIN_BUDGET_MS)).toBe(true);
    expect(performance.now() - began).toBeLessThan(1_000);
  });
});

describe('DuckDB worker settled counter', () => {
  it('counts a request it refuses as malformed, so a drain does not wait for it', async () => {
    const worker = new Worker(workerPath);
    try {
      const ready: unknown = await new Promise((resolve) => { worker.once('message', resolve); });
      const settled = typeof ready === 'object' && ready !== null && 'settled' in ready ? ready.settled : undefined;
      if (!(settled instanceof SharedArrayBuffer)) throw new Error('the ready message carries no settled counter');
      const count = new Int32Array(settled);
      expect(Atomics.load(count, 0)).toBe(0);

      const answered = new Promise((resolve) => { worker.once('message', resolve); });
      worker.postMessage({ kind: 'configure', memoryGB: 'lots' });
      worker.postMessage({ kind: 'query', id: 'one' });
      worker.postMessage({ kind: 'prepared-query', id: 2, sql: 'SELECT 1' });
      // Not requests: neither is counted.
      worker.postMessage({ kind: 'cancel-pending' });
      worker.postMessage('noise');
      worker.postMessage({ kind: 'query', id: 3, sql: 'SELECT 1 AS one' });
      await answered;

      await expect.poll(() => Atomics.load(count, 0)).toBe(4);
    } finally {
      await worker.terminate();
    }
  });
});

describe('DuckDB client terminate', () => {
  it('lets the queries in flight settle before it stops the worker', async () => {
    const client = await createDuckDBClient(workerPath);
    const pooled = inFlight(onStarted => client.runQuery(ENDLESS_SQL, onStarted));
    const build = inFlight(onStarted => client.runBuildQuery(ENDLESS_SQL, onStarted));
    await Promise.all([pooled.started, build.started]);

    await client.terminate();

    // Cancelled by the worker itself: a worker stopped under them would have
    // answered "Worker exited unexpectedly".
    expect(await pooled.outcome).toBe(QUERY_CANCELLED_MESSAGE);
    expect(await build.outcome).toBe(QUERY_CANCELLED_MESSAGE);
  }, 60_000);

  it('can be called twice', async () => {
    const client = await createDuckDBClient(workerPath);
    await client.terminate();
    await expect(client.terminate()).resolves.toBeUndefined();
  });
});
