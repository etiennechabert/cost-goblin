import { initWorkerLifecycle } from './worker-lifecycle.js';

export type RawRow = Readonly<Record<string, unknown>>;

export interface DuckDBClient {
  runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]>;
  runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]>;
  queryStreaming(sql: string, onChunk: (rows: RawRow[], hasMore: boolean) => void, onStarted?: () => void): Promise<void>;
  cancelPendingQueries(): void;
  configure(tempDir: string): void;
  terminate(): Promise<void>;
}

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'started'; id: number }
  | { kind: 'rows'; id: number; rows: RawRow[] }
  | { kind: 'chunk'; id: number; rows: RawRow[]; hasMore: boolean }
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
  if (m['kind'] === 'chunk' && typeof m['id'] === 'number') {
    return Array.isArray(m['rows']) && typeof m['hasMore'] === 'boolean';
  }
  return false;
}

interface PendingQuery {
  resolve: (rows: RawRow[]) => void;
  reject: (err: Error) => void;
  onStarted?: (() => void) | undefined;
}

interface PendingStreamingQuery {
  resolve: () => void;
  reject: (err: Error) => void;
  onChunk: (rows: RawRow[], hasMore: boolean) => void;
  onStarted?: (() => void) | undefined;
}

type PendingRequest = PendingQuery | PendingStreamingQuery;

export async function createDuckDBClient(workerPath: string): Promise<DuckDBClient> {
  const lifecycle = await initWorkerLifecycle<PendingRequest>(
    workerPath,
    (msg) => isWorkerResponse(msg) && msg.kind === 'ready',
    (msg) => {
      if (!isWorkerResponse(msg)) return null;
      if (msg.kind === 'error' && msg.id === -1) return msg.message;
      return null;
    },
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
    if (msg.kind === 'chunk') {
      const entry = pending.get(msg.id);
      if (entry === undefined) return;
      if ('onChunk' in entry) {
        entry.onChunk(msg.rows, msg.hasMore);
        if (!msg.hasMore) {
          pending.delete(msg.id);
          entry.resolve();
        }
      }
      return;
    }
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    pending.delete(msg.id);
    if (msg.kind === 'rows') {
      if ('onChunk' in entry) {
        entry.reject(new Error('Received rows message for streaming query'));
      } else {
        entry.resolve(msg.rows);
      }
    } else {
      entry.reject(new Error(msg.message));
    }
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
      worker.postMessage({ kind, id, sql, ...extraPayload });
    });
  }

  function submitStreamingQuery(
    sql: string,
    onChunk: (rows: RawRow[], hasMore: boolean) => void,
    onStarted?: () => void,
  ): Promise<void> {
    if (lifecycle.fatalError !== null) return Promise.reject(lifecycle.fatalError);
    const id = lifecycle.nextId++;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { onStarted, onChunk, resolve, reject });
      worker.postMessage({ kind: 'streaming-query', id, sql });
    });
  }

  return {
    runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('query', sql, {}, onStarted);
    },
    runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('prepared-query', sql, { params }, onStarted);
    },
    queryStreaming(sql: string, onChunk: (rows: RawRow[], hasMore: boolean) => void, onStarted?: () => void): Promise<void> {
      return submitStreamingQuery(sql, onChunk, onStarted);
    },
    cancelPendingQueries(): void {
      worker.postMessage({ kind: 'cancel-pending' });
    },
    configure(tempDir: string): void {
      worker.postMessage({ kind: 'configure', tempDir });
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
}
