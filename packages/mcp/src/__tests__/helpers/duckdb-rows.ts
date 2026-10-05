import type { DuckDBConnection, DuckDBResult } from '@duckdb/node-api';
import { bindParams } from '@costgoblin/core';
import type { RawRow } from '../../context.js';

// Copied from packages/desktop/src/__tests__/helpers/duckdb-rows.ts — the mcp
// package must not import from desktop. Keep the two in step: these mirror the
// duckdb-worker's row shape. The $1..$n binding is core's bindParams, the one
// the worker itself uses, so a test that runs a tool's prepared SQL here
// exercises the same binding the desktop app does.

/** Drain a DuckDB result into name-keyed rows (the duckdb-worker's row shape). */
async function collectRows(result: DuckDBResult): Promise<RawRow[]> {
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: RawRow[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (let c = 0; c < cols; c++) { const n = names[c]; if (n !== undefined) row[n] = chunk.getColumnVector(c).getItem(r); }
      rows.push(row);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

export async function fetchRows(conn: DuckDBConnection, sql: string): Promise<RawRow[]> {
  return collectRows(await conn.run(sql));
}

export async function fetchRowsPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<RawRow[]> {
  const stmt = await conn.prepare(sql);
  try {
    bindParams(stmt, params);
    return await collectRows(await stmt.run());
  } finally {
    stmt.destroySync();
  }
}
