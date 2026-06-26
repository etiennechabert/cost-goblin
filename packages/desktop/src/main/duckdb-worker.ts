import { parentPort } from 'node:worker_threads';
import type { DuckDBConnection, DuckDBInstance } from './duckdb-loader.js';
import { createResourcePool } from './connection-pool.js';
import type { ResourcePool } from './connection-pool.js';
import { computeDefaultMemoryGB, computeDefaultThreads, computeQueryPoolSize } from './duckdb-tuning.js';

interface DuckDBModule {
  DuckDBInstance: { create: () => Promise<DuckDBInstance> };
}

async function createDuckDB(): Promise<DuckDBInstance> {
  const duckdb = (await import('@duckdb/node-api')) as unknown as DuckDBModule;
  return duckdb.DuckDBInstance.create();
}

interface DuckDBSettings {
  readonly tempDir?: string | undefined;
  readonly memoryGB?: number | undefined;
  readonly threads?: number | undefined;
}

async function configureDuckDB(conn: DuckDBConnection, settings: DuckDBSettings): Promise<void> {
  // memory_limit and threads are instance-global in DuckDB, so applying them on
  // any connection affects the whole instance. Callers pass the resolved
  // effective values (user override or computed default); absent fields fall
  // back to the computed defaults so a partial message never under-provisions.
  const memGB = settings.memoryGB ?? computeDefaultMemoryGB();
  const threads = settings.threads ?? computeDefaultThreads();
  await conn.run(`SET memory_limit = '${String(memGB)}GB'`);
  await conn.run(`SET threads = ${String(threads)}`);
  if (settings.tempDir !== undefined) {
    await conn.run(`SET temp_directory = '${settings.tempDir.replaceAll("'", "''")}'`);
  }
}

if (parentPort === null) {
  throw new Error('duckdb-worker.ts must be run as a Node.js Worker thread');
}
const port = parentPort;

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'started'; id: number }
  | { kind: 'rows'; id: number; rows: Readonly<Record<string, unknown>>[] }
  | { kind: 'error'; id: number; message: string };

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isQueryRequest(msg: unknown): msg is { kind: 'query'; id: number; sql: string; fresh?: boolean } {
  if (!hasProps(msg)) return false;
  if (msg['fresh'] !== undefined && typeof msg['fresh'] !== 'boolean') return false;
  return msg['kind'] === 'query' && typeof msg['id'] === 'number' && typeof msg['sql'] === 'string';
}

function isPreparedQueryRequest(msg: unknown): msg is { kind: 'prepared-query'; id: number; sql: string; params: unknown[] } {
  if (!hasProps(msg)) return false;
  return msg['kind'] === 'prepared-query' && typeof msg['id'] === 'number' && typeof msg['sql'] === 'string' && Array.isArray(msg['params']);
}

function isCancelRequest(msg: unknown): msg is { kind: 'cancel-pending' } {
  if (!hasProps(msg)) return false;
  return msg['kind'] === 'cancel-pending';
}

function isConfigureRequest(msg: unknown): msg is { kind: 'configure'; tempDir?: string; memoryGB?: number; threads?: number } {
  if (!hasProps(msg)) return false;
  if (msg['kind'] !== 'configure') return false;
  if (msg['tempDir'] !== undefined && typeof msg['tempDir'] !== 'string') return false;
  if (msg['memoryGB'] !== undefined && typeof msg['memoryGB'] !== 'number') return false;
  if (msg['threads'] !== undefined && typeof msg['threads'] !== 'number') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Query cancellation state
// ---------------------------------------------------------------------------
const cancelledIds = new Set<number>();
const queuedIds = new Set<number>();  // waiting for pool.acquire()
const runningIds = new Set<number>(); // executing in DuckDB
const runningConns = new Map<number, DuckDBConnection>(); // id → connection for interrupt()

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

function bindParams(stmt: import('./duckdb-loader.js').DuckDBPreparedStatement, params: unknown[]): void {
  for (let i = 0; i < params.length; i++) {
    const val = params[i];
    const idx = i + 1; // DuckDB uses 1-based parameter indices
    if (val === null || val === undefined) {
      stmt.bindNull(idx);
    } else if (typeof val === 'string') {
      stmt.bindVarchar(idx, val);
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        stmt.bindInteger(idx, val);
      } else {
        stmt.bindDouble(idx, val);
      }
    } else if (typeof val === 'boolean') {
      stmt.bindBoolean(idx, val);
    } else if (typeof val === 'bigint') {
      stmt.bindInteger(idx, Number(val));
    } else {
      stmt.bindVarchar(idx, JSON.stringify(val));
    }
  }
}

async function fetchAllRowsPrepared(
  conn: DuckDBConnection,
  sql: string,
  params: unknown[],
  isCancelled: () => boolean,
): Promise<Readonly<Record<string, unknown>>[]> {
  const stmt = await conn.prepare(sql);
  try {
    bindParams(stmt, params);
    const result = await stmt.run();
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
  } finally {
    stmt.destroySync();
  }
}

let poolPromise: Promise<ResourcePool<DuckDBConnection>> | null = null;
let dbInstance: DuckDBInstance | null = null;

function getPool(): Promise<ResourcePool<DuckDBConnection>> {
  poolPromise ??= createDuckDB().then(async (db) => {
    dbInstance = db;
    // Apply memory limit and thread count immediately using a temporary
    // connection. The temp_directory is set later via the 'configure'
    // message once the main thread knows the userData path.
    const initConn = await db.connect();
    await configureDuckDB(initConn, {});
    initConn.disconnectSync();
    return createResourcePool(computeQueryPoolSize(), () => db.connect());
  });
  return poolPromise;
}

/** The initialized DuckDB instance, for callers that need a connection outside
 *  the pool (a `fresh` query). Awaits getPool() so the instance exists and its
 *  memory/thread limits are applied before the first fresh connect. */
async function getInstance(): Promise<DuckDBInstance> {
  await getPool();
  if (dbInstance === null) throw new Error('DuckDB instance not initialized');
  return dbInstance;
}

function send(msg: WorkerResponse): void {
  port.postMessage(msg);
}

void (async () => {
  try {
    await getPool();
    send({ kind: 'ready' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: 'error', id: -1, message: `DuckDB worker init failed: ${message}` });
  }
})();

async function handleRequest(req: { kind: 'query'; id: number; sql: string; fresh?: boolean }): Promise<void> {
  // Check before acquiring a pool connection
  if (cancelledIds.has(req.id)) {
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: 'Query cancelled' });
    return;
  }

  // A `fresh` query runs on a brand-new connection that is disconnected (never
  // returned to the pool) afterward. Rollup partition builds use this: a
  // long-lived connection's buffer/cache accumulates across builds and per-month
  // time climbs (≈2s → 10s); a fresh connection per build keeps each ≈2s.
  const fresh = req.fresh === true;

  // pool/conn are hoisted and the acquisition runs inside the try so that a
  // getPool() or pool.acquire() rejection is turned into an error response by
  // the catch below — otherwise the request would never settle and the caller
  // would hang forever (and its id would leak in queuedIds).
  let pool: ResourcePool<DuckDBConnection> | undefined;
  let conn: DuckDBConnection | undefined;
  try {
    queuedIds.add(req.id);
    if (fresh) {
      conn = await (await getInstance()).connect();
    } else {
      pool = await getPool();
      conn = await pool.acquire();
    }
    queuedIds.delete(req.id);
    send({ kind: 'started', id: req.id });

    // Check after acquiring — cancel may have arrived while queued
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: 'Query cancelled' });
      return;
    }

    runningIds.add(req.id);
    runningConns.set(req.id, conn);
    const rows = await fetchAllRows(conn, req.sql, () => cancelledIds.has(req.id));

    // Skip serialization if cancelled during execution
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: 'Query cancelled' });
    } else {
      send({ kind: 'rows', id: req.id, rows });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isCancelled = cancelledIds.has(req.id) || message.includes('INTERRUPT');
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: isCancelled ? 'Query cancelled' : message });
  } finally {
    queuedIds.delete(req.id);
    runningIds.delete(req.id);
    runningConns.delete(req.id);
    if (conn !== undefined) {
      if (fresh) conn.disconnectSync();
      else if (pool !== undefined) pool.release(conn);
    }
  }
}

async function handlePreparedRequest(req: { kind: 'prepared-query'; id: number; sql: string; params: unknown[] }): Promise<void> {
  // Check before acquiring a pool connection
  if (cancelledIds.has(req.id)) {
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: 'Query cancelled' });
    return;
  }

  // See handleRequest: acquisition runs inside the try so a pool failure can't
  // leave the request hung.
  let pool: ResourcePool<DuckDBConnection> | undefined;
  let conn: DuckDBConnection | undefined;
  try {
    queuedIds.add(req.id);
    pool = await getPool();
    conn = await pool.acquire();
    queuedIds.delete(req.id);
    send({ kind: 'started', id: req.id });

    // Check after acquiring — cancel may have arrived while queued
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: 'Query cancelled' });
      return;
    }

    runningIds.add(req.id);
    runningConns.set(req.id, conn);
    const rows = await fetchAllRowsPrepared(conn, req.sql, req.params, () => cancelledIds.has(req.id));

    // Skip serialization if cancelled during execution
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: 'Query cancelled' });
    } else {
      send({ kind: 'rows', id: req.id, rows });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isCancelled = cancelledIds.has(req.id) || message.includes('INTERRUPT');
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: isCancelled ? 'Query cancelled' : message });
  } finally {
    queuedIds.delete(req.id);
    runningIds.delete(req.id);
    runningConns.delete(req.id);
    if (pool !== undefined && conn !== undefined) pool.release(conn);
  }
}

function handleCancelPending(): void {
  for (const id of queuedIds) {
    cancelledIds.add(id);
  }
  for (const id of runningIds) {
    cancelledIds.add(id);
  }
  // Actively interrupt running DuckDB queries so they release pool
  // connections immediately instead of running to completion.
  for (const conn of runningConns.values()) {
    try { conn.interrupt(); } catch { /* connection may already be closed */ }
  }
}

async function handleConfigure(req: { kind: 'configure'; tempDir?: string; memoryGB?: number; threads?: number }): Promise<void> {
  if (dbInstance === null) return;
  const conn = await dbInstance.connect();
  try {
    await configureDuckDB(conn, { tempDir: req.tempDir, memoryGB: req.memoryGB, threads: req.threads });
  } finally {
    conn.disconnectSync();
  }
}

// Last-resort guard: the handlers settle every request themselves, but if one
// ever rejects unexpectedly we still send an error response (and clean up the
// id) so the caller never hangs waiting on a reply that won't come.
function reportUnexpectedFailure(id: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  cancelledIds.delete(id);
  queuedIds.delete(id);
  runningIds.delete(id);
  runningConns.delete(id);
  send({ kind: 'error', id, message: `DuckDB worker error: ${message}` });
}

port.on('message', (msg: unknown) => {
  if (isQueryRequest(msg)) {
    const { id } = msg;
    handleRequest(msg).catch((err: unknown) => { reportUnexpectedFailure(id, err); });
  } else if (isPreparedQueryRequest(msg)) {
    const { id } = msg;
    handlePreparedRequest(msg).catch((err: unknown) => { reportUnexpectedFailure(id, err); });
  } else if (isCancelRequest(msg)) {
    handleCancelPending();
  } else if (isConfigureRequest(msg)) {
    handleConfigure(msg).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Graceful error handling — prevent worker crashes from taking down Electron
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Notify all pending queries that they failed
  for (const id of runningIds) {
    send({ kind: 'error', id, message: `DuckDB worker error: ${message}` });
  }
  runningIds.clear();
  for (const id of queuedIds) {
    send({ kind: 'error', id, message: `DuckDB worker error: ${message}` });
  }
  queuedIds.clear();
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  for (const id of runningIds) {
    send({ kind: 'error', id, message: `DuckDB worker rejection: ${message}` });
  }
  runningIds.clear();
  for (const id of queuedIds) {
    send({ kind: 'error', id, message: `DuckDB worker rejection: ${message}` });
  }
  queuedIds.clear();
});
