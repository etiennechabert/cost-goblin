import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface DuckDBModule {
  DuckDBInstance: {
    create: () => Promise<DuckDBInstance>;
  };
}

export interface DuckDBInstance {
  connect: () => Promise<DuckDBConnection>;
}

export interface DuckDBConnection {
  run: (sql: string) => Promise<DuckDBResult>;
  disconnectSync: () => void;
}

export interface DuckDBResult {
  columnCount: number;
  columnName: (i: number) => string;
  fetchChunk: () => Promise<DuckDBChunk | null>;
}

export interface DuckDBChunk {
  rowCount: number;
  getColumnVector: (i: number) => DuckDBVector;
}

export interface DuckDBVector {
  getItem: (r: number) => unknown;
}

export async function createDuckDB(): Promise<DuckDBInstance> {
  const duckdb = require('@duckdb/node-api') as DuckDBModule;
  return duckdb.DuckDBInstance.create();
}
