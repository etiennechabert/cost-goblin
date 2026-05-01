import { logger } from '@costgoblin/core';

export type RawRow = Readonly<Record<string, unknown>>;

interface DuckDBModule {
  DuckDBInstance: { create: () => Promise<DuckDBInstance> };
}

interface DuckDBInstance {
  connect: () => Promise<DuckDBConnection>;
}

interface DuckDBConnection {
  run: (sql: string) => Promise<DuckDBResult>;
  prepare: (sql: string) => Promise<DuckDBPreparedStatement>;
}

interface DuckDBPreparedStatement {
  parameterCount: number;
  bindVarchar: (index: number, value: string) => void;
  bindDouble: (index: number, value: number) => void;
  bindInteger: (index: number, value: number) => void;
  bindBoolean: (index: number, value: boolean) => void;
  bindNull: (index: number) => void;
  run: () => Promise<DuckDBResult>;
  destroySync: () => void;
}

interface DuckDBResult {
  columnCount: number;
  columnName: (i: number) => string;
  fetchChunk: () => Promise<DuckDBChunk | null>;
}

interface DuckDBChunk {
  rowCount: number;
  getColumnVector: (i: number) => DuckDBVector;
}

interface DuckDBVector {
  getItem: (r: number) => unknown;
}

interface ResourcePool<T> {
  acquire(): Promise<T>;
  release(resource: T): void;
}

async function createResourcePool<T>(
  size: number,
  factory: () => Promise<T>,
): Promise<ResourcePool<T>> {
  const idle: T[] = [];
  for (let i = 0; i < size; i++) {
    idle.push(await factory());
  }
  const waiters: ((resource: T) => void)[] = [];

  return {
    acquire(): Promise<T> {
      const resource = idle.pop();
      if (resource !== undefined) return Promise.resolve(resource);
      return new Promise<T>(resolve => waiters.push(resolve));
    },
    release(resource: T): void {
      const waiter = waiters.shift();
      if (waiter === undefined) idle.push(resource);
      else waiter(resource);
    },
  };
}

function bindParams(stmt: DuckDBPreparedStatement, params: readonly unknown[]): void {
  for (let i = 0; i < params.length; i++) {
    const val = params[i];
    const idx = i + 1;
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

async function fetchAllRows(conn: DuckDBConnection, sql: string): Promise<RawRow[]> {
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

async function fetchAllRowsPrepared(
  conn: DuckDBConnection,
  sql: string,
  params: readonly unknown[],
): Promise<RawRow[]> {
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

export interface DuckDBPool {
  runQuery(sql: string): Promise<RawRow[]>;
  runPreparedQuery(sql: string, params: readonly unknown[]): Promise<RawRow[]>;
}

const POOL_SIZE = 2;

export async function createDuckDBPool(): Promise<DuckDBPool> {
  const duckdb = (await import('@duckdb/node-api')) as unknown as DuckDBModule;
  const instance = await duckdb.DuckDBInstance.create();
  const pool = await createResourcePool(POOL_SIZE, () => instance.connect());
  logger.info('duckdb: pool ready', { size: POOL_SIZE });

  return {
    async runQuery(sql: string): Promise<RawRow[]> {
      const conn = await pool.acquire();
      try {
        return await fetchAllRows(conn, sql);
      } finally {
        pool.release(conn);
      }
    },
    async runPreparedQuery(sql: string, params: readonly unknown[]): Promise<RawRow[]> {
      const conn = await pool.acquire();
      try {
        return await fetchAllRowsPrepared(conn, sql, params);
      } finally {
        pool.release(conn);
      }
    },
  };
}
