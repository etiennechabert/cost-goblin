import type { DuckDBConnection, DuckDBPreparedStatement, DuckDBResult } from '@duckdb/node-api';
import type { RawRow } from '../../context.js';

// Copied from packages/desktop/src/__tests__/helpers/duckdb-rows.ts, and
// bindParams from packages/desktop/src/main/duckdb-bind.ts — the mcp package
// must not import from desktop. Keep them in step: these mirror the
// duckdb-worker's row shape and $1..$n binding, so a test that runs a tool's
// prepared SQL here exercises the same binding the desktop app does.

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

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

/** Positional $1..$n binding, mirroring the duckdb-worker's bindParams: an
 *  integer binds as the narrowest DuckDB integer type that holds it (a number
 *  past int64 as DOUBLE; a bigint past int128 throws). */
function bindParams(stmt: DuckDBPreparedStatement, params: readonly unknown[]): void {
  for (let i = 0; i < params.length; i++) {
    const idx = i + 1;
    const val = params[i];
    if (val === null || val === undefined) {
      stmt.bindNull(idx);
    } else if (typeof val === 'string') {
      stmt.bindVarchar(idx, val);
    } else if (typeof val === 'number') {
      bindNumberParam(stmt, idx, val);
    } else if (typeof val === 'boolean') {
      stmt.bindBoolean(idx, val);
    } else if (typeof val === 'bigint') {
      bindBigintParam(stmt, idx, val);
    } else {
      stmt.bindVarchar(idx, JSON.stringify(val));
    }
  }
}

function bindNumberParam(stmt: DuckDBPreparedStatement, idx: number, val: number): void {
  if (!Number.isInteger(val)) {
    stmt.bindDouble(idx, val);
  } else if (val >= INT32_MIN && val <= INT32_MAX) {
    stmt.bindInteger(idx, val);
  } else {
    const big = BigInt(val);
    if (big >= INT64_MIN && big <= INT64_MAX) stmt.bindBigInt(idx, big);
    else stmt.bindDouble(idx, val);
  }
}

function bindBigintParam(stmt: DuckDBPreparedStatement, idx: number, val: bigint): void {
  if (val >= INT64_MIN && val <= INT64_MAX) {
    stmt.bindBigInt(idx, val);
  } else if (val >= INT128_MIN && val <= INT128_MAX) {
    stmt.bindHugeInt(idx, val);
  } else {
    throw new RangeError(`Parameter $${String(idx)} is outside the HUGEINT range (128-bit signed integer)`);
  }
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
