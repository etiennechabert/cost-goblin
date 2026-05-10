import { parentPort } from 'node:worker_threads';
import { cpus, totalmem } from 'node:os';
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

function computeMemoryLimitGB(): number {
  const totalGB = totalmem() / (1024 * 1024 * 1024);
  return Math.min(4, Math.max(1, Math.round(totalGB * 0.5)));
}

async function configureDuckDB(conn: DuckDBConnection, tempDir: string | undefined): Promise<void> {
  const memGB = computeMemoryLimitGB();
  await conn.run(`SET memory_limit = '${String(memGB)}GB'`);
  if (tempDir !== undefined) {
    await conn.run(`SET temp_directory = '${tempDir.replaceAll("'", "''")}'`);
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
  | { kind: 'chunk'; id: number; rows: Readonly<Record<string, unknown>>[]; hasMore: boolean }
  | { kind: 'error'; id: number; message: string };

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isQueryRequest(msg: unknown): msg is { kind: 'query'; id: number; sql: string } {
  if (!hasProps(msg)) return false;
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

function isConfigureRequest(msg: unknown): msg is { kind: 'configure'; tempDir: string } {
  if (!hasProps(msg)) return false;
  return msg['kind'] === 'configure' && typeof msg['tempDir'] === 'string';
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

async function fetchRowsChunked(
  conn: DuckDBConnection,
  sql: string,
  chunkSize: number,
  isCancelled: () => boolean,
  onChunk: (rows: Readonly<Record<string, unknown>>[], hasMore: boolean) => void,
): Promise<void> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));

  let buffer: Record<string, unknown>[] = [];
  let chunk = await result.fetchChunk();

  while (chunk !== null && chunk.rowCount > 0) {
    if (isCancelled()) return;

    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (let c = 0; c < cols; c++) {
        const name = names[c];
        if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
      }
      buffer.push(row);

      // Send chunk when buffer reaches chunkSize
      if (buffer.length >= chunkSize) {
        onChunk(buffer, true);
        buffer = [];
      }
    }

    chunk = await result.fetchChunk();
  }

  // Send final chunk with hasMore = false
  onChunk(buffer, false);
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

function parsePoolSize(): number {
  const raw = process.env['COSTGOBLIN_DUCKDB_POOL_SIZE'];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 32) return n;
  }
  return Math.min(Math.max(4, cpus().length), 16);
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
    await configureDuckDB(initConn, undefined);
    initConn.disconnectSync();
    return createResourcePool(parsePoolSize(), () => db.connect());
  });
  return poolPromise;
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

async function handleRequest(req: { kind: 'query'; id: number; sql: string }): Promise<void> {
  // Check before acquiring a pool connection
  if (cancelledIds.has(req.id)) {
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: 'Query cancelled' });
    return;
  }

  queuedIds.add(req.id);
  const pool = await getPool();
  const conn = await pool.acquire();
  queuedIds.delete(req.id);
  send({ kind: 'started', id: req.id });

  try {
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
    runningIds.delete(req.id);
    runningConns.delete(req.id);
    pool.release(conn);
  }
}

async function handlePreparedRequest(req: { kind: 'prepared-query'; id: number; sql: string; params: unknown[] }): Promise<void> {
  // Check before acquiring a pool connection
  if (cancelledIds.has(req.id)) {
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: 'Query cancelled' });
    return;
  }

  queuedIds.add(req.id);
  const pool = await getPool();
  const conn = await pool.acquire();
  queuedIds.delete(req.id);
  send({ kind: 'started', id: req.id });

  try {
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
    runningIds.delete(req.id);
    runningConns.delete(req.id);
    pool.release(conn);
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

async function handleConfigure(req: { kind: 'configure'; tempDir: string }): Promise<void> {
  if (dbInstance === null) return;
  const conn = await dbInstance.connect();
  try {
    await conn.run(`SET temp_directory = '${req.tempDir.replaceAll("'", "''")}'`);
  } finally {
    conn.disconnectSync();
  }
}

port.on('message', (msg: unknown) => {
  if (isQueryRequest(msg)) {
    handleRequest(msg).catch(() => undefined);
  } else if (isPreparedQueryRequest(msg)) {
    handlePreparedRequest(msg).catch(() => undefined);
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
