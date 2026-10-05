/** The binders `bindParams` uses: a structural slice of a `@duckdb/node-api`
 *  prepared statement, so the desktop DuckDB worker, the desktop and MCP test
 *  helpers, and a test recording the calls with a plain object all bind
 *  through this one implementation. Pure leaf module (no imports), so the
 *  worker can take it from the browser entry. */
export interface DuckDBParamBinder {
  bindNull: (index: number) => void;
  bindVarchar: (index: number, value: string) => void;
  bindBoolean: (index: number, value: boolean) => void;
  bindInteger: (index: number, value: number) => void;
  bindBigInt: (index: number, value: bigint) => void;
  bindHugeInt: (index: number, value: bigint) => void;
  bindDouble: (index: number, value: number) => void;
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

/** Bind positional $1..$n parameters. An integer goes to the narrowest DuckDB
 *  integer type that holds it, since each binder refuses (INTEGER, BIGINT) or
 *  silently wraps (HUGEINT) a value wider than its type:
 *  - a number binds as INTEGER within int32, BIGINT within int64, and DOUBLE
 *    beyond (past 2^53 a number is already rounded; DOUBLE keeps that value);
 *  - a bigint binds as BIGINT within int64 and HUGEINT within int128; beyond
 *    that it throws a RangeError rather than run the query on a wrapped number.
 *  Fractions bind as DOUBLE, null/undefined as NULL, anything else as JSON text. */
export function bindParams(stmt: DuckDBParamBinder, params: readonly unknown[]): void {
  for (let i = 0; i < params.length; i++) {
    const val = params[i];
    const idx = i + 1; // DuckDB uses 1-based parameter indices
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

function bindNumberParam(stmt: DuckDBParamBinder, idx: number, val: number): void {
  if (!Number.isInteger(val)) {
    stmt.bindDouble(idx, val);
  } else if (val >= INT32_MIN && val <= INT32_MAX) {
    stmt.bindInteger(idx, val);
  } else {
    // An integral number converts to a BigInt exactly, so the int64 bounds are
    // checked without float rounding (2^63 - 1 is no double: it rounds to 2^63).
    const big = BigInt(val);
    if (big >= INT64_MIN && big <= INT64_MAX) stmt.bindBigInt(idx, big);
    else stmt.bindDouble(idx, val);
  }
}

function bindBigintParam(stmt: DuckDBParamBinder, idx: number, val: bigint): void {
  if (val >= INT64_MIN && val <= INT64_MAX) {
    stmt.bindBigInt(idx, val);
  } else if (val >= INT128_MIN && val <= INT128_MAX) {
    stmt.bindHugeInt(idx, val);
  } else {
    throw new RangeError(`Parameter $${String(idx)} is outside the HUGEINT range (128-bit signed integer)`);
  }
}
