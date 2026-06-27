import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  let worker: ChildProcess;
  let nextId = 1;

  function sendQuery(id: number, sql: string): void {
    worker.send({ kind: 'query', id, sql });
  }

  function sendPreparedQuery(id: number, sql: string, params: unknown[]): void {
    worker.send({ kind: 'prepared-query', id, sql, params });
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
    // 'advanced' serialization mirrors production (worker-lifecycle.ts) and lets
    // BigInt/Date survive IPC, which the default JSON serialization can't.
    worker = fork(workerPath, [], { serialization: 'advanced' });
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

  afterAll(() => {
    worker.kill();
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
    worker.send('invalid');
    worker.send(0);
    worker.send({ kind: 'query', id: 999 });
    worker.send({ kind: 'query' });
    worker.send({ kind: 'prepared-query', id: 998 });
    worker.send({ kind: 'unknown' });

    const id = nextId++;
    sendQuery(id, 'SELECT 1');
    expect((await waitForResult(id)).kind).toBe('rows');
  });

  it('handles cancel-pending without crashing', async () => {
    const id = nextId++;
    sendQuery(id, 'SELECT 1');
    worker.send({ kind: 'cancel-pending' });
    const result = await waitForResult(id);
    expect(['rows', 'error']).toContain(result.kind);
    expect(result.id).toBe(id);
  });

  it('remains healthy after cancellation', async () => {
    const cancelId = nextId++;
    sendQuery(cancelId, 'SELECT 1');
    worker.send({ kind: 'cancel-pending' });
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
