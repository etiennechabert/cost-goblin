import type { DuckDBConnection, DuckDBResult } from '@duckdb/node-api';
import { bindParams } from '../../main/duckdb-bind.js';
import type { RawRow } from '../../main/duckdb-client.js';

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

/** Positional $1..$n binding through the duckdb-worker's own bindParams. */
export async function fetchRowsPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<RawRow[]> {
  const stmt = await conn.prepare(sql);
  try {
    bindParams(stmt, params);
    return await collectRows(await stmt.run());
  } finally {
    stmt.destroySync();
  }
}
