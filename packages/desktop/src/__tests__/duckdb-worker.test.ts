import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDbSandboxOptions } from '@costgoblin/core';
import { createDuckDBClient } from '../main/duckdb-client.js';
import type { DuckDBClient } from '../main/duckdb-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', '..', 'out', 'worker', 'duckdb-worker.cjs');

// Fail loudly instead of silently skipping 16 tests when the bundle is missing
if (!existsSync(workerPath)) {
  throw new Error(
    `Worker bundle not found at ${workerPath}. Run "npm run build:worker" in packages/desktop first.`,
  );
}

// ---------------------------------------------------------------------------
// Response types — mirrors WorkerResponse from duckdb-worker.ts
// ---------------------------------------------------------------------------

interface RowsMsg {
  kind: 'rows';
  id: number;
  rows: Record<string, unknown>[];
}

interface ErrorMsg {
  kind: 'error';
  id: number;
  message: string;
}

interface StartedMsg {
  kind: 'started';
  id: number;
}

type ResultMsg = RowsMsg | ErrorMsg;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isResultMsg(msg: unknown): msg is ResultMsg {
  if (!hasProps(msg) || typeof msg['id'] !== 'number') return false;
  if (msg['kind'] === 'rows' && Array.isArray(msg['rows'])) return true;
  if (msg['kind'] === 'error' && typeof msg['message'] === 'string') return true;
  return false;
}

function isStartedMsg(msg: unknown): msg is StartedMsg {
  return hasProps(msg) && msg['kind'] === 'started' && typeof msg['id'] === 'number';
}

function expectRows(result: ResultMsg): RowsMsg {
  expect(result.kind).toBe('rows');
  if (result.kind !== 'rows') throw new Error(`Expected rows, got ${result.kind}`);
  return result;
}

// ---------------------------------------------------------------------------

describe('DuckDB Worker', () => {
  let worker: Worker;
  let nextId = 1;

  function sendQuery(id: number, sql: string): void {
    worker.postMessage({ kind: 'query', id, sql });
  }

  function sendPreparedQuery(id: number, sql: string, params: unknown[]): void {
    worker.postMessage({ kind: 'prepared-query', id, sql, params });
  }

  function waitForResult(id: number): Promise<ResultMsg> {
    return new Promise<ResultMsg>((resolve) => {
      const handler = (msg: unknown): void => {
        if (isResultMsg(msg) && msg.id === id) {
          worker.off('message', handler);
          resolve(msg);
        }
      };
      worker.on('message', handler);
    });
  }

  function waitForStarted(id: number): Promise<StartedMsg> {
    return new Promise<StartedMsg>((resolve) => {
      const handler = (msg: unknown): void => {
        if (isStartedMsg(msg) && msg.id === id) {
          worker.off('message', handler);
          resolve(msg);
        }
      };
      worker.on('message', handler);
    });
  }

  beforeAll(async () => {
    worker = new Worker(workerPath);
    // The concurrency test attaches one transient listener per in-flight query,
    // which can exceed the default cap of 10. Raise it to avoid noisy warnings.
    worker.setMaxListeners(100);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Worker ready timeout')); }, 10000);
      worker.once('message', (msg) => {
        clearTimeout(timeout);
        expect(msg).toEqual({ kind: 'ready' });
        resolve();
      });
      worker.once('error', (e: unknown) => {
        clearTimeout(timeout);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  });

  afterAll(async () => {
    await worker.terminate();
  });

  it('completes simple query', async () => {
    const id = nextId++;
    sendQuery(id, 'SELECT 1 AS value');
    const { rows } = expectRows(await waitForResult(id));
    expect(rows).toHaveLength(1);
  });

  it('sends started message before rows', async () => {
    const id = nextId++;
    sendQuery(id, 'SELECT 42 AS answer');
    const started = await waitForStarted(id);
    expect(started).toEqual({ kind: 'started', id });
    expect((await waitForResult(id)).kind).toBe('rows');
  });

  it('executes prepared query with parameters', async () => {
    const id = nextId++;
    sendPreparedQuery(id, 'SELECT $1::INTEGER AS num, $2::VARCHAR AS str', [42, 'hello']);
    const { rows } = expectRows(await waitForResult(id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('num', 42);
    expect(rows[0]).toHaveProperty('str', 'hello');
  });

  it('handles prepared query with null parameters', async () => {
    const id = nextId++;
    sendPreparedQuery(id, 'SELECT $1 AS val', [null]);
    expect((await waitForResult(id)).kind).toBe('rows');
  });

  it('handles prepared query with boolean parameters', async () => {
    const id = nextId++;
    sendPreparedQuery(id, 'SELECT $1::BOOLEAN AS flag', [true]);
    const { rows } = expectRows(await waitForResult(id));
    expect(rows[0]).toHaveProperty('flag', true);
  });

  it('handles prepared query with float parameters', async () => {
    const id = nextId++;
    sendPreparedQuery(id, 'SELECT $1::DOUBLE AS num', [3.14]);
    const { rows } = expectRows(await waitForResult(id));
    expect(rows[0]).toHaveProperty('num');
  });

  it('returns error for invalid SQL', async () => {
    const id = nextId++;
    sendQuery(id, 'SELECT FROM INVALID SYNTAX');
    const result = await waitForResult(id);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(typeof result.message).toBe('string');
    }
  });

  it('releases connections on the error path under concurrency', async () => {
    // Fire many more failing queries than the pool has connections. If a failed
    // query leaked its pool connection (or hung without responding), the pool
    // would drain and later queries would never settle.
    const failIds = Array.from({ length: 40 }, () => nextId++);
    for (const id of failIds) sendQuery(id, 'SELECT FROM totally invalid');
    const results = await Promise.all(failIds.map(id => waitForResult(id)));
    for (const r of results) expect(r.kind).toBe('error');

    // Worker is still healthy afterwards.
    const okId = nextId++;
    sendQuery(okId, 'SELECT 1 AS ok');
    expect((await waitForResult(okId)).kind).toBe('rows');
  });

  it('ignores malformed messages without crashing', async () => {
    worker.postMessage('invalid');
    worker.postMessage(null);
    worker.postMessage({ kind: 'query', id: 999 });
    worker.postMessage({ kind: 'query' });
    worker.postMessage({ kind: 'prepared-query', id: 998 });
    worker.postMessage({ kind: 'unknown' });

    const id = nextId++;
    sendQuery(id, 'SELECT 1');
    expect((await waitForResult(id)).kind).toBe('rows');
  });

  it('handles cancel-pending without crashing', async () => {
    const id = nextId++;
    sendQuery(id, 'SELECT 1');
    worker.postMessage({ kind: 'cancel-pending' });
    const result = await waitForResult(id);
    expect(['rows', 'error']).toContain(result.kind);
    expect(result.id).toBe(id);
  });

  it('remains healthy after cancellation', async () => {
    const cancelId = nextId++;
    sendQuery(cancelId, 'SELECT 1');
    worker.postMessage({ kind: 'cancel-pending' });
    await waitForResult(cancelId);

    const afterId = nextId++;
    sendQuery(afterId, 'SELECT 2');
    expect((await waitForResult(afterId)).kind).toBe('rows');
  });

  it('handles sequential queries with correct IDs', async () => {
    const ids = [nextId++, nextId++, nextId++];
    for (const id of ids) {
      sendQuery(id, `SELECT ${String(id)} AS query_id`);
      expect((await waitForResult(id)).id).toBe(id);
    }
  });

  it('handles concurrent queries without cross-talk', async () => {
    const id1 = nextId++;
    const id2 = nextId++;
    sendQuery(id1, 'SELECT 100 AS val');
    sendQuery(id2, 'SELECT 200 AS val');
    const [r1, r2] = await Promise.all([waitForResult(id1), waitForResult(id2)]);
    expect(r1).toMatchObject({ id: id1, kind: 'rows' });
    expect(r2).toMatchObject({ id: id2, kind: 'rows' });
  });

  it('handles concurrent prepared queries', async () => {
    const id1 = nextId++;
    const id2 = nextId++;
    sendPreparedQuery(id1, 'SELECT $1::INTEGER AS n', [10]);
    sendPreparedQuery(id2, 'SELECT $1::INTEGER AS n', [20]);
    const [r1, r2] = await Promise.all([waitForResult(id1), waitForResult(id2)]);
    expect(r1).toMatchObject({ id: id1, kind: 'rows' });
    expect(r2).toMatchObject({ id: id2, kind: 'rows' });
  });

  it('returns empty array when query has no results', async () => {
    const id = nextId++;
    sendQuery(id, 'SELECT 1 WHERE FALSE');
    const { rows } = expectRows(await waitForResult(id));
    expect(rows).toEqual([]);
  });

  it('executes queries with multiple rows', async () => {
    const id = nextId++;
    sendQuery(id, 'SELECT unnest([1, 2, 3, 4, 5]) AS num');
    const { rows } = expectRows(await waitForResult(id));
    expect(rows).toHaveLength(5);
  });

  it('handles query with multiple columns', async () => {
    const id = nextId++;
    sendQuery(id, "SELECT 1 AS a, 'text' AS b, true AS c");
    const { rows } = expectRows(await waitForResult(id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('a');
    expect(rows[0]).toHaveProperty('b');
    expect(rows[0]).toHaveProperty('c');
  });
});

// ---------------------------------------------------------------------------
// Sandboxed mode (#594) — the dedicated MCP instance
// ---------------------------------------------------------------------------

const CANARY = 'CANARY-WORKER-SECRET-594';

/** Spawn a worker with `workerData` and resolve with its first message (ready
 *  or the id -1 init error). */
function spawnWithData(data: unknown): Promise<{ worker: Worker; first: unknown }> {
  const w = new Worker(workerPath, { workerData: data });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Worker init timeout')); }, 10000);
    w.once('message', (msg: unknown) => {
      clearTimeout(timeout);
      resolve({ worker: w, first: msg });
    });
    w.once('error', (e: unknown) => {
      clearTimeout(timeout);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

function isInitError(msg: unknown): msg is ErrorMsg {
  return isResultMsg(msg) && msg.kind === 'error' && msg.id === -1;
}

describe('DuckDB Worker (sandboxed)', () => {
  let root: string;
  let dataDir: string;
  let outsideDir: string;
  let sandbox: DuckDbSandboxOptions;

  beforeAll(async () => {
    root = (await realpath(await mkdtemp(join(tmpdir(), 'cg-worker-sandbox-')))).replaceAll('\\', '/');
    dataDir = `${root}/data`;
    outsideDir = `${root}/outside`;
    const monthDir = `${dataDir}/aws/raw/daily-2026-01`;
    await mkdir(monthDir, { recursive: true });
    await mkdir(`${root}/tmp`, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(`${outsideDir}/creds.txt`, CANARY);

    const setupDb = await DuckDBInstance.create();
    const setup = await setupDb.connect();
    await setup.run(`COPY (SELECT TIMESTAMP '2026-01-07 00:00:00' AS ChargePeriodStart, 3.5 AS EffectiveCost) TO '${monthDir}/data.parquet' (FORMAT PARQUET)`);
    setup.disconnectSync();
    setupDb.closeSync();

    sandbox = {
      allowedDirectories: [dataDir, `${root}/tmp`],
      allowedPaths: [],
      tempDirectory: `${root}/tmp`,
      memoryLimitGB: 1,
      threads: 2,
    };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('raw worker protocol', () => {
    let worker: Worker;
    let nextId = 1;

    function query(sql: string, fresh?: boolean): Promise<ResultMsg> {
      const id = nextId++;
      return new Promise<ResultMsg>((resolve) => {
        const handler = (msg: unknown): void => {
          if (isResultMsg(msg) && msg.id === id) {
            worker.off('message', handler);
            resolve(msg);
          }
        };
        worker.on('message', handler);
        worker.postMessage(fresh === true ? { kind: 'query', id, sql, fresh } : { kind: 'query', id, sql });
      });
    }

    function expectDenied(result: ResultMsg): void {
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.message).toMatch(/Permission Error/);
      expect(result.message).not.toContain(CANARY);
    }

    beforeAll(async () => {
      const spawned = await spawnWithData({ sandbox });
      worker = spawned.worker;
      expect(spawned.first).toEqual({ kind: 'ready' });
    });

    afterAll(async () => {
      await worker.terminate();
    });

    it('reads Parquet under the data dir', async () => {
      const { rows } = expectRows(await query(
        `SELECT MAX(ChargePeriodStart::DATE)::VARCHAR AS d FROM read_parquet(['${dataDir}/aws/raw/daily-2026-01/*.parquet'])`,
      ));
      expect(rows[0]).toHaveProperty('d', '2026-01-07');
    });

    it('refuses a file outside the grants, on pooled and fresh connections', async () => {
      expectDenied(await query(`SELECT content FROM read_text('${outsideDir}/creds.txt')`));
      expectDenied(await query(`SELECT content FROM read_text('${outsideDir}/creds.txt')`, true));
    });

    it('applied the sandbox limits and ignores a later configure', async () => {
      const before = expectRows(await query(`SELECT current_setting('memory_limit') AS m, current_setting('threads')::INTEGER AS t`));
      expect(before.rows[0]).toHaveProperty('t', 2);

      worker.postMessage({ kind: 'configure', tempDir: outsideDir, memoryGB: 7, threads: 5 });
      // configure is fire-and-forget; a round-trip query orders after it.
      const after = expectRows(await query(`SELECT current_setting('memory_limit') AS m, current_setting('threads')::INTEGER AS t`));
      expect(after.rows[0]).toEqual(before.rows[0]);
      expectDenied(await query(`SELECT content FROM read_text('${outsideDir}/creds.txt')`));
    });

    it('stays locked against a SET smuggled into a query', async () => {
      const result = await query('SET enable_external_access = true');
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.message).toMatch(/locked/);
    });
  });

  it.each([
    ['a string', 'sandbox'],
    ['a missing sandbox key', { notSandbox: true }],
    ['a non-object sandbox', { sandbox: 42 }],
    ['a relative directory', { sandbox: { allowedDirectories: ['data'], allowedPaths: [], tempDirectory: '/tmp', memoryLimitGB: 1, threads: 1 } }],
    ['an empty directory list', { sandbox: { allowedDirectories: [], allowedPaths: [], tempDirectory: '/tmp', memoryLimitGB: 1, threads: 1 } }],
    ['zero threads', { sandbox: { allowedDirectories: ['/tmp'], allowedPaths: [], tempDirectory: '/tmp', memoryLimitGB: 1, threads: 0 } }],
  ])('malformed workerData (%s) yields the init error instead of ready', async (_label, data) => {
    const { worker: w, first } = await spawnWithData(data);
    try {
      expect(isInitError(first)).toBe(true);
      if (isInitError(first)) expect(first.message).toMatch(/sandbox setup failed/);
    } finally {
      await w.terminate();
    }
  });

  describe('createDuckDBClient', () => {
    let client: DuckDBClient | null = null;

    afterAll(async () => {
      if (client !== null) await client.terminate();
    });

    it('serves a sandboxed client', async () => {
      client = await createDuckDBClient(workerPath, { sandbox });
      const rows = await client.runQuery(`SELECT COUNT(*)::INTEGER AS n FROM read_parquet('${dataDir}/aws/raw/daily-*/*.parquet')`);
      expect(rows[0]).toHaveProperty('n', 1);
      await expect(client.runQuery(`SELECT content FROM read_text('${outsideDir}/creds.txt')`)).rejects.toThrow(/Permission Error/);
      await expect(client.runPreparedQuery('SELECT content FROM read_text($1)', [`${outsideDir}/creds.txt`])).rejects.toThrow(/Permission Error/);
    });

    it('rejects (fail closed) when the sandbox cannot be applied', async () => {
      await expect(createDuckDBClient(workerPath, {
        sandbox: { ...sandbox, allowedDirectories: ['relative/dir'] },
      })).rejects.toThrow(/sandbox setup failed/);
    });
  });
});
