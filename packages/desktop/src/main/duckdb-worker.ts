import { parentPort } from 'node:worker_threads';
import { cpus } from 'node:os';
import type { DuckDBConnection, DuckDBInstance } from './duckdb-loader.js';
import { createResourcePool } from './connection-pool.js';
import type { ResourcePool } from './connection-pool.js';

interface DuckDBModule {
  DuckDBInstance: { create: () => Promise<DuckDBInstance> };
}

async function createDuckDB(): Promise<DuckDBInstance> {
  const duckdb = (await import('@duckdb/node-api')) as unknown as DuckDBModule;
  return duckdb.DuckDBInstance.create();
}

if (parentPort === null) {
  throw new Error('duckdb-worker.ts must be run as a Node.js Worker thread');
}
const port = parentPort;

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'rows'; id: number; rows: Readonly<Record<string, unknown>>[] }
  | { kind: 'error'; id: number; message: string };

function isQueryRequest(msg: unknown): msg is { kind: 'query'; id: number; sql: string } {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m['kind'] === 'query' && typeof m['id'] === 'number' && typeof m['sql'] === 'string';
}

function isCancelRequest(msg: unknown): msg is { kind: 'cancel-pending' } {
  if (typeof msg !== 'object' || msg === null) return false;
  return (msg as Record<string, unknown>)['kind'] === 'cancel-pending';
}

// ---------------------------------------------------------------------------
// Query cancellation state
// ---------------------------------------------------------------------------
const cancelledIds = new Set<number>();
const queuedIds = new Set<number>();  // waiting for pool.acquire()
const runningIds = new Set<number>(); // executing in DuckDB

async function fetchAllRows(
  conn: DuckDBConnection,
  sql: string,
  isCancelled: () => boolean,
): Promise<Readonly<Record<string, unknown>>[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));

  const rows: Record<string, unknown>[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    if (isCancelled()) return [];
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (let c = 0; c < cols; c++) {
        const name = names[c];
        if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
      }
      rows.push(row);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

/**
 * Pool of DuckDB connections on one DuckDBInstance. A single connection
 * serializes queries internally — with N connections, independent queries
 * execute in parallel (bound by DuckDB's own thread scheduling). Queries
 * arriving while all connections are busy queue FIFO via ResourcePool.
 *
 * Size defaults to the number of logical CPUs (min 4, max 16). Override
 * with COSTGOBLIN_DUCKDB_POOL_SIZE.
 */
function parsePoolSize(): number {
  const raw = process.env['COSTGOBLIN_DUCKDB_POOL_SIZE'];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 32) return n;
  }
  return Math.min(Math.max(4, cpus().length), 16);
}

let poolPromise: Promise<ResourcePool<DuckDBConnection>> | null = null;

function getPool(): Promise<ResourcePool<DuckDBConnection>> {
  if (poolPromise === null) {
    poolPromise = createDuckDB().then(db => createResourcePool(parsePoolSize(), () => db.connect()));
  }
  return poolPromise;
}

function send(msg: WorkerResponse): void {
  port.postMessage(msg);
}

void getPool().then(() => {
  send({ kind: 'ready' });
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  send({ kind: 'error', id: -1, message: `DuckDB worker init failed: ${message}` });
});

async function handleRequest(req: { kind: 'query'; id: number; sql: string }): Promise<void> {
  // Check before acquiring a pool connection
  if (cancelledIds.has(req.id)) {
    cancelledIds.delete(req.id);
    send({ kind: 'rows', id: req.id, rows: [] });
    return;
  }

  queuedIds.add(req.id);
  const pool = await getPool();
  const conn = await pool.acquire();
  queuedIds.delete(req.id);

  try {
    // Check after acquiring — cancel may have arrived while queued
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'rows', id: req.id, rows: [] });
      return;
    }

    runningIds.add(req.id);
    const rows = await fetchAllRows(conn, req.sql, () => cancelledIds.has(req.id));

    // Skip serialization if cancelled during execution
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'rows', id: req.id, rows: [] });
    } else {
      send({ kind: 'rows', id: req.id, rows });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: 'error', id: req.id, message });
  } finally {
    runningIds.delete(req.id);
    pool.release(conn);
  }
}

function handleCancelPending(): void {
  for (const id of queuedIds) {
    cancelledIds.add(id);
  }
}

port.on('message', (msg: unknown) => {
  if (isQueryRequest(msg)) {
    void handleRequest(msg);
  } else if (isCancelRequest(msg)) {
    handleCancelPending();
  }
});
