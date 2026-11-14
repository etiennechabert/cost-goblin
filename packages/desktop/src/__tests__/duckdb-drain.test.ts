import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { QUERY_CANCELLED_MESSAGE } from '@costgoblin/core';
import { CLIENT_TERMINATED_MESSAGE, createDuckDBClient, drainDuckDBClientsSync } from '../main/duckdb-client.js';
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

// The process exiting ends every worker thread, under a running query as under
// none, and a DuckDB call still in flight then aborts the process: its
// completion runs in an environment that can no longer take it, throws, and
// nothing catches it. The exit handler drains the workers first.
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

      await expect(client.runQuery('SELECT 1')).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);
      await expect(client.runBuildQuery('SELECT 1')).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);
      await expect(client.runPreparedQuery('SELECT 1', [])).rejects.toThrow(CLIENT_TERMINATED_MESSAGE);
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

// An abort cannot be asserted from inside the process it kills: the exit
// itself runs in a process of its own (helpers/duckdb-exit-child.ts), with
// the same exit handler as the app's main process.
describe('a process exiting with queries in flight', () => {
  const childPath = join(__dirname, 'helpers', 'duckdb-exit-child.ts');

  interface ChildExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }

  function exitChild(mode: 'running' | 'just-sent'): Promise<ChildExit> {
    return new Promise<ChildExit>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', childPath, workerPath, mode], {
        cwd: __dirname,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      // The queries run for minutes: a child still alive by then did not exit.
      const killer = setTimeout(() => { child.kill('SIGKILL'); }, 45_000);
      child.once('error', (err) => {
        clearTimeout(killer);
        reject(err);
      });
      child.once('close', (code, signal) => {
        clearTimeout(killer);
        resolve({ code, signal, stderr });
      });
    });
  }

  it.each([
    ['queries DuckDB is executing', 'running'],
    ['queries that were only just sent', 'just-sent'],
  ] as const)('exits cleanly, with %s', async (_label, mode) => {
    const exit = await exitChild(mode);

    expect(exit.stderr).not.toContain('Napi::Error');
    expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
  }, 60_000);
});
