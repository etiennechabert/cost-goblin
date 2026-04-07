import { createRequire } from 'node:module';

interface DuckDBChunk {
  rowCount: number;
  getColumnVector: (i: number) => { getItem: (r: number) => unknown };
}

interface DuckDBResult {
  columnCount: number;
  fetchChunk: () => Promise<DuckDBChunk | null>;
}

export interface LazyDuckDBConnection {
  run: (sql: string) => Promise<DuckDBResult>;
}

export interface LazyDuckDBInstance {
  connect: () => Promise<LazyDuckDBConnection>;
}

export async function createLazyDuckDB(): Promise<LazyDuckDBInstance> {
  const req = createRequire(import.meta.url);
  const mod = req('@duckdb/node-api') as { DuckDBInstance: { create: () => Promise<LazyDuckDBInstance> } };
  return mod.DuckDBInstance.create();
}
