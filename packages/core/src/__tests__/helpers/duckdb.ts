import type { DuckDBConnection, DuckDBPreparedStatement } from '@duckdb/node-api';

/** A result row keyed by column name. */
export type Row = Record<string, unknown>;

/** Runs `sql` and drains the result into name-keyed rows, each value as DuckDB
 *  hands it over (a DATE is a DuckDBDateValue, a HUGEINT a bigint, …). */
export async function queryAll(conn: DuckDBConnection, sql: string): Promise<Row[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: Row[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Row = {};
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

/** Positional `$1..$n` binding for the parameter types the query builders
 *  emit. Anything else is a test bug, so it throws instead of guessing. */
function bindParams(stmt: DuckDBPreparedStatement, params: readonly unknown[]): void {
  params.forEach((value, i) => {
    if (typeof value === 'string') stmt.bindVarchar(i + 1, value);
    else if (typeof value === 'number' && Number.isInteger(value)) stmt.bindInteger(i + 1, value);
    else if (typeof value === 'number') stmt.bindDouble(i + 1, value);
    else throw new Error(`unexpected query parameter ${String(value)}`);
  });
}

/** Runs a builder's `{ sql, params }` and returns the rows as JSON-shaped
 *  values (dates and timestamps as strings, HUGEINT as a string). */
export async function runPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<Row[]> {
  const stmt = await conn.prepare(sql);
  try {
    bindParams(stmt, params);
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjectsJson();
  } finally {
    stmt.destroySync();
  }
}

/** `runPrepared`, with each value as DuckDB hands it over instead of JSON-shaped. */
export async function runPreparedValues(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<Row[]> {
  const stmt = await conn.prepare(sql);
  try {
    bindParams(stmt, params);
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjects();
  } finally {
    stmt.destroySync();
  }
}
