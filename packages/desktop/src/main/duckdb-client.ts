import { logger } from '@costgoblin/core';
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
  /** Cancel the queries a view is waiting on, queued or running. Rollup
   *  partition builds (`runBuildQuery`) keep running: a click must not cost the
   *  rollup a month. */
  cancelPendingQueries(): void;
  /** Cancel everything, builds included. For a caller about to drop or replace
   *  what the builds read and write: a cache clear, a provider's removal. */
  cancelAllQueries(): void;
  configure(settings: { tempDir?: string; memoryGB?: number; threads?: number }): void;
  /** Stop the worker. Queries still in flight are cancelled first and the
   *  thread is ended only once they have answered: tearing it down under a
   *  running query aborts the whole process hosting it. Queries sent afterwards
   *  are rejected with {@link CLIENT_TERMINATED_MESSAGE}. Resolves when the
   *  worker has ended, or after {@link TERMINATE_GRACE_MS} if a query is still
   *  running by then (the worker is then ended as soon as it settles). */
  terminate(): Promise<void>;
}

/** What a query sent after `terminate()` is rejected with. */
export const CLIENT_TERMINATED_MESSAGE = 'DuckDB client terminated';

/** How long `terminate()` keeps its caller waiting for the queries in flight to
 *  answer their cancel. A cancelled query answers within milliseconds, so this
 *  only runs out when DuckDB is somewhere an interrupt doesn't reach. The
 *  worker is NOT terminated at that point: that would abort the process. It is
 *  left to finish and is terminated once nothing runs in it. */
export const TERMINATE_GRACE_MS = 5_000;

/** A cancel that reaches DuckDB before the query starts executing is lost, so
 *  `terminate()` repeats it at this interval while a query is in flight. */
export const CANCEL_RESEND_MS = 100;

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

/** Data handed to the DuckDB worker at spawn. `sandbox` switches the worker to
 *  a dedicated, locked-down instance (see `buildDuckDbSandboxStatements`); the
 *  worker applies it before reporting ready and fails init if it can't. */
export interface DuckDBWorkerData {
  readonly sandbox: DuckDbSandboxOptions;
}

// ---------------------------------------------------------------------------
// Quit — the process exiting with queries in flight
// ---------------------------------------------------------------------------
// The process exiting tears every worker thread down, under a running query
// as under none, and that aborts it just as an early terminate() would. The
// process's exit handler therefore drains the workers first. It cannot do what
// terminate() does: at exit the event loop no longer turns, so the workers'
// answers are never received. What an exiting process can still do is read
// shared memory, so each worker counts the requests it has settled there.

/** One client's part in the drain at exit. */
interface Drainable {
  /** Tells the worker to cancel everything. The client runs nothing afterwards. */
  beginDrain(): void;
  /** Blocks until the worker has settled every request posted to it, or
   *  `deadline` (epoch ms) passed. False when requests were still in flight. */
  waitSettledSync(deadline: number): boolean;
}

/** The clients whose worker thread is alive. */
const liveClients = new Set<Drainable>();

/** The longest the exit waits for the queries in flight to settle. They are
 *  all cancelled first and settle in milliseconds; this bounds the worst case,
 *  a query DuckDB is slow to interrupt. */
export const QUIT_DRAIN_MS = 3_000;

/** For the process's exit handler: cancels every query of every DuckDB worker,
 *  builds included, and blocks until they have all settled or `timeoutMs`
 *  passed. False when some were still in flight at the deadline. */
export function drainDuckDBClientsSync(timeoutMs: number = QUIT_DRAIN_MS): boolean {
  const deadline = Date.now() + timeoutMs;
  for (const client of liveClients) client.beginDrain();
  let settled = true;
  for (const client of liveClients) settled = client.waitSettledSync(deadline) && settled;
  return settled;
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
    notifyIfDrained();
  });

  // terminate() waits here for the worker to have nothing in flight: every
  // request answered, or no thread left to protect. (The lifecycle's own
  // 'error'/'exit' listeners, registered first, have emptied `pending` by the
  // time these run.)
  let exited = false;
  let onDrained: (() => void) | null = null;
  function notifyIfDrained(): void {
    if (onDrained === null || (pending.size > 0 && !exited)) return;
    const notify = onDrained;
    onDrained = null;
    notify();
  }
  worker.on('error', notifyIfDrained);
  worker.on('exit', () => {
    exited = true;
    liveClients.delete(drainable);
    notifyIfDrained();
  });

  /** Requests posted to the worker: its settled count catches up with this
   *  once nothing is in flight. */
  let posted = 0;
  let drainRequested = false;
  const drainable: Drainable = {
    beginDrain(): void {
      // Nothing may start in a worker that is on its way out.
      lifecycle.fatalError ??= new Error(CLIENT_TERMINATED_MESSAGE);
      // A worker that shares no counter cannot be waited on: nothing to ask of it.
      if (drainRequested || exited || settledCount === undefined) return;
      drainRequested = true;
      worker.postMessage({ kind: 'drain' });
    },
    waitSettledSync(deadline: number): boolean {
      for (;;) {
        if (exited || settledCount === undefined) return true;
        const seen = Atomics.load(settledCount, 0);
        if (seen >= posted) return true;
        const left = deadline - Date.now();
        if (left <= 0) return false;
        Atomics.wait(settledCount, 0, seen, left);
      }
    },
  };
  liveClients.add(drainable);

  async function shutDown(): Promise<void> {
    // Nothing may start in a worker that is on its way out.
    lifecycle.fatalError ??= new Error(CLIENT_TERMINATED_MESSAGE);
    if (pending.size === 0 || exited) {
      await worker.terminate();
      return;
    }

    // Builds included: a worker on its way out finishes nothing, and a build
    // left running would hold terminate() for its whole grace period.
    const cancel = (): void => { worker.postMessage({ kind: 'cancel-pending', builds: true }); };
    cancel();
    const resend = setInterval(cancel, CANCEL_RESEND_MS);
    const ended = new Promise<void>((resolve) => { onDrained = resolve; }).then(async (): Promise<'ended'> => {
      clearInterval(resend);
      await worker.terminate();
      return 'ended';
    });

    let graceTimer: NodeJS.Timeout | undefined;
    const graceOver = new Promise<'grace-over'>((resolve) => {
      graceTimer = setTimeout(() => { resolve('grace-over'); }, TERMINATE_GRACE_MS);
    });
    try {
      if (await Promise.race([ended, graceOver]) === 'ended') return;
    } finally {
      clearTimeout(graceTimer);
    }
    // The caller stops waiting; the thread does not get torn down under its
    // query. `ended` still terminates it once the query settles.
    logger.warn('duckdb: a query is still running after terminate; the worker ends once it settles', {
      inFlight: pending.size,
      graceMs: TERMINATE_GRACE_MS,
    });
    ended.catch((err: unknown) => {
      logger.warn('duckdb: ending the worker after its last query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  let termination: Promise<void> | null = null;

  function submitQuery(
    kind: string,
    sql: string,
    extraPayload: Record<string, unknown>,
    onStarted?: () => void,
  ): Promise<RawRow[]> {
    if (lifecycle.fatalError !== null) return Promise.reject(lifecycle.fatalError);
    const id = lifecycle.nextId++;
    return new Promise<RawRow[]>((resolve, reject) => {
      pending.set(id, { onStarted, resolve, reject });
      try {
        worker.postMessage({ kind, id, sql, ...extraPayload });
      } catch (err: unknown) {
        // Nothing reached the worker (a parameter that cannot be cloned), so
        // nothing will answer: counted or left pending, the request would
        // keep a drain and terminate() waiting until their deadlines.
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      posted += 1;
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
    cancelAllQueries(): void {
      worker.postMessage({ kind: 'cancel-pending', builds: true });
    },
    configure(settings: { tempDir?: string; memoryGB?: number; threads?: number }): void {
      worker.postMessage({ kind: 'configure', ...settings });
      posted += 1;
    },
    terminate(): Promise<void> {
      termination ??= shutDown();
      return termination;
    },
  };
}
