import { parentPort } from 'node:worker_threads';
import type { DuckDBConnection, DuckDBInstance } from './duckdb-loader.js';

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

type WorkerRequest =
  | { kind: 'query'; id: number; sql: string };

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'rows'; id: number; rows: Readonly<Record<string, unknown>>[] }
  | { kind: 'error'; id: number; message: string };

function isQueryRequest(msg: unknown): msg is { kind: 'query'; id: number; sql: string } {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m['kind'] === 'query' && typeof m['id'] === 'number' && typeof m['sql'] === 'string';
}

async function fetchAllRows(conn: DuckDBConnection, sql: string): Promise<Readonly<Record<string, unknown>>[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));

  const rows: Record<string, unknown>[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
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

let connectionPromise: Promise<DuckDBConnection> | null = null;

async function getConnection(): Promise<DuckDBConnection> {
  if (connectionPromise === null) {
    connectionPromise = createDuckDB().then(db => db.connect());
  }
  return connectionPromise;
}

function send(msg: WorkerResponse): void {
  port.postMessage(msg);
}

void getConnection().then(() => {
  send({ kind: 'ready' });
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Surface init failure as an error response with id -1; the client treats
  // any error before `ready` as fatal and rejects all in-flight + future queries.
  send({ kind: 'error', id: -1, message: `DuckDB worker init failed: ${message}` });
});

async function handleRequest(req: WorkerRequest): Promise<void> {
  try {
    const conn = await getConnection();
    const rows = await fetchAllRows(conn, req.sql);
    send({ kind: 'rows', id: req.id, rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: 'error', id: req.id, message });
  }
}

port.on('message', (msg: unknown) => {
  if (isQueryRequest(msg)) {
    void handleRequest(msg);
  }
});
