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
  terminate(): Promise<void>;
}

type WorkerResponse =
  | { kind: 'ready' }
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

export async function createDuckDBClient(workerPath: string): Promise<DuckDBClient> {
  // The DuckDB engine runs in a forked child process so a native OOM kills only
  // that process; the lifecycle auto-restarts it and replays the last config.
  const lifecycle = await initWorkerLifecycle<PendingQuery>(
    workerPath,
    (msg) => isWorkerResponse(msg) && msg.kind === 'ready',
    (msg) => {
      if (!isWorkerResponse(msg)) return null;
      if (msg.kind === 'error' && msg.id === -1) return msg.message;
      return null;
    },
    { backend: 'process', autoRestart: true },
  );
  const { pending } = lifecycle;

  // The lifecycle re-attaches this handler automatically after a restart, so we
  // register it once and stay oblivious to which child process is current.
  lifecycle.setMessageHandler((msg: unknown) => {
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
    const id = lifecycle.nextId++;
    return new Promise<RawRow[]>((resolve, reject) => {
      pending.set(id, { onStarted, resolve, reject });
      lifecycle.post({ kind, id, sql, ...extraPayload });
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
      lifecycle.post({ kind: 'cancel-pending' });
    },
    configure(settings: { tempDir?: string; memoryGB?: number; threads?: number }): void {
      const msg = { kind: 'configure', ...settings };
      lifecycle.lastConfig = msg;
      lifecycle.post(msg);
    },
    terminate(): Promise<void> {
      return lifecycle.terminate();
    },
  };
}
