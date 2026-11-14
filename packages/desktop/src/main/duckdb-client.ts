import { QUERY_CANCELLED_MESSAGE } from '@costgoblin/core';
import type { DuckDbSandboxOptions } from '@costgoblin/core';
import { initWorkerLifecycle } from './worker-lifecycle.js';

export type RawRow = Readonly<Record<string, unknown>>;

export interface DuckDBClient {
  runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]>;
  runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]>;
  /** Run on a brand-new connection that is disposed afterward (never pooled).
   *  Used for rollup partition builds so per-build time stays flat — a reused
   *  connection's buffer/cache accumulates and later builds slow down. */
  runBuildQuery(sql: string, onStarted?: () => void): Promise<RawRow[]>;
  cancelPendingQueries(): void;
  configure(settings: { tempDir?: string; memoryGB?: number; threads?: number }): void;
  /** Cancels everything, waits (briefly) until the worker has settled every
   *  request, then stops it. The client runs nothing afterwards. */
  terminate(): Promise<void>;
}

type WorkerResponse =
  | { kind: 'ready'; settled?: unknown }
  | { kind: 'started'; id: number }
  | { kind: 'rows'; id: number; rows: RawRow[] }
  | { kind: 'error'; id: number; message: string };

function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m['kind'] === 'ready') return true;
  if (m['kind'] === 'started' && typeof m['id'] === 'number') return true;
  if ((m['kind'] === 'rows' || m['kind'] === 'error') && typeof m['id'] === 'number') {
    if (m['kind'] === 'rows') return Array.isArray(m['rows']);
    return typeof m['message'] === 'string';
  }
  return false;
}

interface PendingQuery {
  resolve: (rows: RawRow[]) => void;
  reject: (err: Error) => void;
  onStarted?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// Drain — tearing a worker down without taking the process with it
// ---------------------------------------------------------------------------
// A DuckDB call still in flight when its worker thread is torn down aborts the
// whole process: the call's completion runs in an environment that can no
// longer take it, throws, and nothing catches the throw ("terminating due to
// uncaught exception of type Napi::Error"). Both ways a thread goes are
// covered: the process exiting (drainDuckDBClientsSync, from its exit
// handler) and the client stopping its worker (terminate).

/** One client's part in a drain. */
interface Drainable {
  /** Tells the worker to cancel everything. The client runs nothing afterwards. */
  beginDrain(): void;
  /** Blocks until the worker has settled every request posted to it, or
   *  `deadline` (epoch ms) passed. False when requests were still in flight. */
  waitSettledSync(deadline: number): boolean;
}

/** The clients whose worker is alive. */
const liveClients = new Set<Drainable>();

/** The longest a drain waits for the queries in flight to settle, at exit and
 *  in terminate(). They are all cancelled first and settle in milliseconds;
 *  this bounds the worst case, a query DuckDB is slow to interrupt. */
export const DUCKDB_DRAIN_MS = 3_000;

/** For the process's exit handler: cancels every query of every DuckDB worker
 *  and blocks until they have all settled, or `timeoutMs` passed. False when
 *  some were still in flight at the deadline.
 *
 *  Synchronous on purpose: at exit the event loop no longer turns, so the
 *  workers' answers cannot be received, only their shared counter read. */
export function drainDuckDBClientsSync(timeoutMs: number = DUCKDB_DRAIN_MS): boolean {
  const deadline = Date.now() + timeoutMs;
  for (const client of liveClients) client.beginDrain();
  let settled = true;
  for (const client of liveClients) settled = client.waitSettledSync(deadline) && settled;
  return settled;
}

const TERMINATE_POLL_MS = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Data handed to the DuckDB worker at spawn. `sandbox` switches the worker to
 *  a dedicated, locked-down instance (see `buildDuckDbSandboxStatements`); the
 *  worker applies it before reporting ready and fails init if it can't. */
export interface DuckDBWorkerData {
  readonly sandbox: DuckDbSandboxOptions;
}

/** Spawn a DuckDB worker. Without `workerData` it is the app's shared,
 *  unrestricted instance; with `workerData.sandbox` it is sandboxed and locked,
 *  and the promise rejects (with the worker already terminated) if the sandbox
 *  cannot be applied — callers must not fall back to an unsandboxed client. */
export async function createDuckDBClient(workerPath: string, workerData?: DuckDBWorkerData): Promise<DuckDBClient> {
  // The worker's count of settled requests, from its ready message. A worker
  // that sends none cannot be waited on.
  let settledCount: Int32Array | undefined;
  const lifecycle = await initWorkerLifecycle<PendingQuery>(
    workerPath,
    (msg) => {
      if (!isWorkerResponse(msg) || msg.kind !== 'ready') return false;
      if (msg.settled instanceof SharedArrayBuffer) settledCount = new Int32Array(msg.settled);
      return true;
    },
    (msg) => {
      if (!isWorkerResponse(msg)) return null;
      if (msg.kind === 'error' && msg.id === -1) return msg.message;
      return null;
    },
    workerData,
  );
  const { worker, pending } = lifecycle;

  /** Requests posted to the worker: the worker's settled count catches up
   *  with this once nothing is in flight. */
  let posted = 0;
  let draining = false;
  let exited = false;

  const drainable: Drainable = {
    beginDrain(): void {
      if (draining || exited) return;
      draining = true;
      // A worker that shares no counter cannot be waited on: nothing to ask of it.
      if (settledCount !== undefined) worker.postMessage({ kind: 'drain' });
    },
    waitSettledSync(deadline: number): boolean {
      for (;;) {
        // Nothing to wait on: the worker is gone, has failed, or shares no counter.
        if (exited || lifecycle.fatalError !== null || settledCount === undefined) return true;
        const seen = Atomics.load(settledCount, 0);
        if (seen >= posted) return true;
        const left = deadline - Date.now();
        if (left <= 0) return false;
        Atomics.wait(settledCount, 0, seen, left);
      }
    },
  };
  liveClients.add(drainable);
  worker.once('exit', () => {
    exited = true;
    liveClients.delete(drainable);
  });

  worker.on('message', (msg: unknown) => {
    if (!isWorkerResponse(msg)) return;
    if (msg.kind === 'ready') return;
    if (msg.kind === 'started') {
      const entry = pending.get(msg.id);
      if (entry?.onStarted !== undefined) entry.onStarted();
      return;
    }
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    pending.delete(msg.id);
    if (msg.kind === 'rows') entry.resolve(msg.rows);
    else entry.reject(new Error(msg.message));
  });

  function submitQuery(
    kind: string,
    sql: string,
    extraPayload: Record<string, unknown>,
    onStarted?: () => void,
  ): Promise<RawRow[]> {
    if (lifecycle.fatalError !== null) return Promise.reject(lifecycle.fatalError);
    if (draining) return Promise.reject(new Error(QUERY_CANCELLED_MESSAGE));
    const id = lifecycle.nextId++;
    return new Promise<RawRow[]>((resolve, reject) => {
      pending.set(id, { onStarted, resolve, reject });
      posted += 1;
      worker.postMessage({ kind, id, sql, ...extraPayload });
    });
  }

  return {
    runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('query', sql, {}, onStarted);
    },
    runBuildQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('query', sql, { fresh: true }, onStarted);
    },
    runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('prepared-query', sql, { params }, onStarted);
    },
    cancelPendingQueries(): void {
      worker.postMessage({ kind: 'cancel-pending' });
    },
    configure(settings: { tempDir?: string; memoryGB?: number; threads?: number }): void {
      if (draining) return;
      posted += 1;
      worker.postMessage({ kind: 'configure', ...settings });
    },
    async terminate(): Promise<void> {
      drainable.beginDrain();
      const deadline = Date.now() + DUCKDB_DRAIN_MS;
      // Polled, not blocked on: the worker's answers to the cancelled queries
      // have to be received meanwhile, or their callers would hear that the
      // worker exited instead.
      while (!drainable.waitSettledSync(0) && Date.now() < deadline) await delay(TERMINATE_POLL_MS);
      await worker.terminate();
    },
  };
}
