import { parentPort, workerData } from 'node:worker_threads';
// Imported from the browser-safe entry so esbuild bundles only these (pure)
// modules' graph into the worker — never the node-only sync/aws code that
// the full `@costgoblin/core` barrel would pull in (it isn't externalized here).
import { QUERY_CANCELLED_MESSAGE, buildDuckDbSandboxStatements, isDuckDbSandboxOptions } from '@costgoblin/core/browser';
import type { DuckDBConnection, DuckDBInstance } from './duckdb-loader.js';
import { createResourcePool } from './connection-pool.js';
import type { ResourcePool } from './connection-pool.js';
import { DUCKDB_SETTINGS_ENV, computeDefaultMemoryGB, computeDefaultThreads, computeQueryPoolSize } from './duckdb-tuning.js';

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

/** The settings whoever spawned this process passed in its environment: for
 *  a process that replaces a dead one, everything `configure` was told so
 *  far. They are applied before 'ready', which a 'configure' message cannot
 *  promise: the queries held for the new process are sent right behind it,
 *  and one that spilled before `temp_directory` was set would pin DuckDB's
 *  default directory for good. Nothing is passed to a worker thread. */
function spawnSettings(): DuckDBSettings {
  const raw = process.env[DUCKDB_SETTINGS_ENV];
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSettings(parsed)) return {};
    return { tempDir: parsed.tempDir, memoryGB: parsed.memoryGB, threads: parsed.threads };
  } catch {
    return {};
  }
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

// ---------------------------------------------------------------------------
// Who started this bundle
// ---------------------------------------------------------------------------

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isSettings(value: unknown): value is Record<string, unknown> & { tempDir?: string; memoryGB?: number; threads?: number } {
  if (!hasProps(value)) return false;
  if (value['tempDir'] !== undefined && typeof value['tempDir'] !== 'string') return false;
  if (value['memoryGB'] !== undefined && typeof value['memoryGB'] !== 'number') return false;
  if (value['threads'] !== undefined && typeof value['threads'] !== 'number') return false;
  return true;
}

/** The channel to whoever started this bundle. */
interface ParentLink {
  post(message: WorkerResponse): void;
  onMessage(listener: (message: unknown) => void): void;
}

/** `process.parentPort` as an Electron utility process has it. */
interface UtilityParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
}

function isUtilityParentPort(value: unknown): value is UtilityParentPort {
  return hasProps(value) && typeof value['postMessage'] === 'function' && typeof value['on'] === 'function';
}

/** The same bundle runs under three hosts, told apart by the channel each
 *  one gives it:
 *  - a worker thread of the main process: the MCP server's sandboxed instance;
 *  - an Electron utility process: the app's shared instance, in a process of
 *    its own so that a native failure in DuckDB ends this process and not the
 *    app (`duckdb-supervisor.ts` starts the next one);
 *  - a child process forked by Node: how the integration tests run that same
 *    shared instance without Electron. */
function connectToParent(): ParentLink {
  if (parentPort !== null) {
    const port = parentPort;
    return {
      post: (message) => { port.postMessage(message); },
      onMessage: (listener) => { port.on('message', listener); },
    };
  }
  const utilityPort: unknown = Reflect.get(process, 'parentPort');
  if (isUtilityParentPort(utilityPort)) {
    return {
      post: (message) => { utilityPort.postMessage(message); },
      onMessage: (listener) => { utilityPort.on('message', (event) => { listener(event.data); }); },
    };
  }
  if (typeof process.send === 'function') {
    const send = process.send.bind(process);
    // The parent is gone: nobody is left to answer. Killed, not exited: an
    // exit that tears Node down while a query runs aborts in DuckDB's
    // binding ("uncaught exception of type Napi::Error"), and this must not
    // leave a crash report for a process nobody was using.
    process.on('disconnect', () => { process.kill(process.pid, 'SIGKILL'); });
    return {
      post: (message) => { send(message); },
      onMessage: (listener) => { process.on('message', listener); },
    };
  }
  throw new Error('duckdb-worker must be started as a worker thread, an Electron utility process or a forked child process');
}

const parent = connectToParent();

// ---------------------------------------------------------------------------
// Worker mode — decided once from workerData at spawn
// ---------------------------------------------------------------------------

/** `shared`: the app's unrestricted instance (dashboards, Explorer, rollups),
 *  tuned by later 'configure' messages; the only mode outside a worker thread,
 *  where there is no workerData. `sandboxed`: a dedicated instance for
 *  untrusted (MCP) SQL — the ordered sandbox SETs run on the init connection
 *  before 'ready', the configuration is then locked, and 'configure' is
 *  ignored. `invalid`: workerData was present but malformed; init fails. */
type WorkerMode =
  | { readonly kind: 'shared' }
  | { readonly kind: 'sandboxed'; readonly statements: readonly string[] }
  | { readonly kind: 'invalid'; readonly reason: string };

function resolveWorkerMode(data: unknown): WorkerMode {
  if (data === undefined || data === null) return { kind: 'shared' };
  if (!hasProps(data) || !isDuckDbSandboxOptions(data['sandbox'])) {
    return { kind: 'invalid', reason: 'malformed workerData (expected { sandbox: DuckDbSandboxOptions })' };
  }
  try {
    return { kind: 'sandboxed', statements: buildDuckDbSandboxStatements(data['sandbox']) };
  } catch (err: unknown) {
    return { kind: 'invalid', reason: err instanceof Error ? err.message : String(err) };
  }
}

const mode: WorkerMode = resolveWorkerMode(workerData);

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'started'; id: number }
  | { kind: 'rows'; id: number; rows: Readonly<Record<string, unknown>>[] }
  | { kind: 'error'; id: number; message: string };

function isQueryRequest(msg: unknown): msg is { kind: 'query'; id: number; sql: string; fresh?: boolean } {
  if (!hasProps(msg)) return false;
  if (msg['fresh'] !== undefined && typeof msg['fresh'] !== 'boolean') return false;
  return msg['kind'] === 'query' && typeof msg['id'] === 'number' && typeof msg['sql'] === 'string';
}

function isPreparedQueryRequest(msg: unknown): msg is { kind: 'prepared-query'; id: number; sql: string; params: unknown[] } {
  if (!hasProps(msg)) return false;
  return msg['kind'] === 'prepared-query' && typeof msg['id'] === 'number' && typeof msg['sql'] === 'string' && Array.isArray(msg['params']);
}

function isCancelRequest(msg: unknown): msg is { kind: 'cancel-pending'; builds?: boolean } {
  if (!hasProps(msg)) return false;
  if (msg['builds'] !== undefined && typeof msg['builds'] !== 'boolean') return false;
  return msg['kind'] === 'cancel-pending';
}

function isConfigureRequest(msg: unknown): msg is { kind: 'configure'; tempDir?: string; memoryGB?: number; threads?: number } {
  return isSettings(msg) && msg['kind'] === 'configure';
}

// ---------------------------------------------------------------------------
// Query cancellation state
// ---------------------------------------------------------------------------
const cancelledIds = new Set<number>();
const queuedIds = new Set<number>();  // waiting for pool.acquire()
const runningIds = new Set<number>(); // executing in DuckDB
const runningConns = new Map<number, DuckDBConnection>(); // id → connection for interrupt()
const buildIds = new Set<number>();   // `fresh` queries: rollup partition builds

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

/** Sandboxed mode: run the ordered sandbox SETs (lock last) on the init
 *  connection. Any failure propagates — the instance is closed and init fails,
 *  so the caller never gets an unsandboxed instance it believes is sandboxed. */
async function applySandbox(db: DuckDBInstance, initConn: DuckDBConnection, statements: readonly string[]): Promise<void> {
  try {
    for (const stmt of statements) {
      await initConn.run(stmt);
    }
  } catch (err: unknown) {
    initConn.disconnectSync();
    db.closeSync();
    throw err;
  }
}

function getPool(): Promise<ResourcePool<DuckDBConnection>> {
  poolPromise ??= (async () => {
    if (mode.kind === 'invalid') throw new Error(`sandbox setup failed: ${mode.reason}`);
    const db = await createDuckDB();
    const initConn = await db.connect();
    if (mode.kind === 'sandboxed') {
      await applySandbox(db, initConn, mode.statements);
    } else {
      // Before 'ready', so no query ever runs under other settings: a process
      // host hands over the settings at spawn (see spawnSettings). Without
      // any, the computed defaults apply and a 'configure' message sets the
      // rest later.
      await configureDuckDB(initConn, spawnSettings());
    }
    initConn.disconnectSync();
    dbInstance = db;
    return createResourcePool(computeQueryPoolSize(), () => db.connect());
  })();
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
  parent.post(msg);
}

// Workers run under Electron's ESM loader too, so kick off init from a named
// async function rather than top-level await.
async function initWorker(): Promise<void> {
  try {
    await getPool();
    send({ kind: 'ready' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: 'error', id: -1, message: `DuckDB worker init failed: ${message}` });
  }
}
void initWorker();

async function handleRequest(req: { kind: 'query'; id: number; sql: string; fresh?: boolean }): Promise<void> {
  // Check before acquiring a pool connection
  if (cancelledIds.has(req.id)) {
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: QUERY_CANCELLED_MESSAGE });
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
      buildIds.add(req.id);
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
      send({ kind: 'error', id: req.id, message: QUERY_CANCELLED_MESSAGE });
      return;
    }

    runningIds.add(req.id);
    runningConns.set(req.id, conn);
    const rows = await fetchAllRows(conn, req.sql, () => cancelledIds.has(req.id));

    // Skip serialization if cancelled during execution
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: QUERY_CANCELLED_MESSAGE });
    } else {
      send({ kind: 'rows', id: req.id, rows });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isCancelled = cancelledIds.has(req.id) || message.includes('INTERRUPT');
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: isCancelled ? QUERY_CANCELLED_MESSAGE : message });
  } finally {
    queuedIds.delete(req.id);
    runningIds.delete(req.id);
    runningConns.delete(req.id);
    buildIds.delete(req.id);
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
    send({ kind: 'error', id: req.id, message: QUERY_CANCELLED_MESSAGE });
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
      send({ kind: 'error', id: req.id, message: QUERY_CANCELLED_MESSAGE });
      return;
    }

    runningIds.add(req.id);
    runningConns.set(req.id, conn);
    const rows = await fetchAllRowsPrepared(conn, req.sql, req.params, () => cancelledIds.has(req.id));

    // Skip serialization if cancelled during execution
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: QUERY_CANCELLED_MESSAGE });
    } else {
      send({ kind: 'rows', id: req.id, rows });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isCancelled = cancelledIds.has(req.id) || message.includes('INTERRUPT');
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: isCancelled ? QUERY_CANCELLED_MESSAGE : message });
  } finally {
    queuedIds.delete(req.id);
    runningIds.delete(req.id);
    runningConns.delete(req.id);
    if (pool !== undefined && conn !== undefined) pool.release(conn);
  }
}

/** Cancel what is queued or running. A view's cancel (`includeBuilds` false:
 *  sent on every navigation and date change) spares the rollup partition
 *  builds. They are not that view's queries, and a cancelled build is not
 *  retried: its month stays out of the rollup, so every query over it reads
 *  the raw export until the next warmup. Clicking around during the build at
 *  launch used to lose most of a year that way. */
function handleCancelPending(includeBuilds: boolean): void {
  const spared = (id: number): boolean => !includeBuilds && buildIds.has(id);
  for (const id of queuedIds) {
    if (!spared(id)) cancelledIds.add(id);
  }
  for (const id of runningIds) {
    if (!spared(id)) cancelledIds.add(id);
  }
  // Actively interrupt running DuckDB queries so they release pool
  // connections immediately instead of running to completion.
  keepInterruptingCancelled();
}

const REINTERRUPT_INTERVAL_MS = 25;
let reinterruptTimer: NodeJS.Timeout | null = null;

/** Interrupt the connection of every cancelled query that has not settled.
 *  Returns whether there was one. */
function interruptCancelled(): boolean {
  let pending = false;
  for (const [id, conn] of runningConns) {
    if (!cancelledIds.has(id)) continue;
    pending = true;
    try { conn.interrupt(); } catch { /* connection may already be closed */ }
  }
  return pending;
}

/** Interrupt the cancelled queries now, then again every few milliseconds
 *  until each has settled. One interrupt is not enough: DuckDB clears a
 *  connection's interrupted flag when a query begins on it, and a query in
 *  `runningConns` may not have begun. Its task waits for a free thread of
 *  libuv's pool (four by default, shared by the whole process), and a
 *  prepared query takes two tasks. An interrupt made in that gap was dropped,
 *  and the query ran to its end before it was reported cancelled. */
function keepInterruptingCancelled(): void {
  if (!interruptCancelled() || reinterruptTimer !== null) return;
  reinterruptTimer = setInterval(() => {
    if (interruptCancelled() || reinterruptTimer === null) return;
    clearInterval(reinterruptTimer);
    reinterruptTimer = null;
  }, REINTERRUPT_INTERVAL_MS);
}

async function handleConfigure(req: { kind: 'configure'; tempDir?: string; memoryGB?: number; threads?: number }): Promise<void> {
  // A sandboxed instance is locked (every SET fails) and its limits were fixed
  // at spawn; ignore rather than attempt a reconfiguration.
  if (mode.kind !== 'shared') return;
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
  buildIds.delete(id);
  send({ kind: 'error', id, message: `DuckDB worker error: ${message}` });
}

parent.onMessage((msg: unknown) => {
  if (isQueryRequest(msg)) {
    const { id } = msg;
    handleRequest(msg).catch((err: unknown) => { reportUnexpectedFailure(id, err); });
  } else if (isPreparedQueryRequest(msg)) {
    const { id } = msg;
    handlePreparedRequest(msg).catch((err: unknown) => { reportUnexpectedFailure(id, err); });
  } else if (isCancelRequest(msg)) {
    handleCancelPending(msg.builds === true);
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
