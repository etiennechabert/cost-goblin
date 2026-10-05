import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { bindParams, type DuckDBParamBinder } from '../main/duckdb-bind.js';
import { fetchRowsPrepared } from './helpers/duckdb-rows.js';

type BindCall = readonly [binder: string, index: number, value?: unknown];

function recordBinds(params: readonly unknown[]): BindCall[] {
  const calls: BindCall[] = [];
  const stmt: DuckDBParamBinder = {
    bindNull: (i) => { calls.push(['bindNull', i]); },
    bindVarchar: (i, v) => { calls.push(['bindVarchar', i, v]); },
    bindBoolean: (i, v) => { calls.push(['bindBoolean', i, v]); },
    bindInteger: (i, v) => { calls.push(['bindInteger', i, v]); },
    bindBigInt: (i, v) => { calls.push(['bindBigInt', i, v]); },
    bindHugeInt: (i, v) => { calls.push(['bindHugeInt', i, v]); },
    bindDouble: (i, v) => { calls.push(['bindDouble', i, v]); },
  };
  bindParams(stmt, params);
  return calls;
}

describe('bindParams (which binder each value gets)', () => {
  it('binds integers within int32 as INTEGER', () => {
    expect(recordBinds([0, -1, 2 ** 31 - 1, -(2 ** 31)])).toEqual([
      ['bindInteger', 1, 0],
      ['bindInteger', 2, -1],
      ['bindInteger', 3, 2 ** 31 - 1],
      ['bindInteger', 4, -(2 ** 31)],
    ]);
  });

  it('binds integral numbers past int32 as BIGINT', () => {
    expect(recordBinds([2 ** 31, -(2 ** 31) - 1, 2 ** 40, Number.MAX_SAFE_INTEGER, -(2 ** 63)])).toEqual([
      ['bindBigInt', 1, 2n ** 31n],
      ['bindBigInt', 2, -(2n ** 31n) - 1n],
      ['bindBigInt', 3, 2n ** 40n],
      ['bindBigInt', 4, 2n ** 53n - 1n],
      ['bindBigInt', 5, -(2n ** 63n)],
    ]);
  });

  it('binds integral numbers past int64 as DOUBLE (2^63 itself included)', () => {
    expect(recordBinds([2 ** 63, -(2 ** 64), 1e300])).toEqual([
      ['bindDouble', 1, 2 ** 63],
      ['bindDouble', 2, -(2 ** 64)],
      ['bindDouble', 3, 1e300],
    ]);
  });

  it('binds bigints as BIGINT, and as HUGEINT past int64', () => {
    expect(recordBinds([3n, 2n ** 53n + 2n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 63n, -(2n ** 63n) - 1n, 2n ** 127n - 1n, -(2n ** 127n)])).toEqual([
      ['bindBigInt', 1, 3n],
      ['bindBigInt', 2, 2n ** 53n + 2n],
      ['bindBigInt', 3, 2n ** 63n - 1n],
      ['bindBigInt', 4, -(2n ** 63n)],
      ['bindHugeInt', 5, 2n ** 63n],
      ['bindHugeInt', 6, -(2n ** 63n) - 1n],
      ['bindHugeInt', 7, 2n ** 127n - 1n],
      ['bindHugeInt', 8, -(2n ** 127n)],
    ]);
  });

  it('refuses a bigint past HUGEINT rather than bind a wrapped value', () => {
    expect(() => recordBinds(['ok', 2n ** 127n])).toThrow(RangeError);
    expect(() => recordBinds([-(2n ** 127n) - 1n])).toThrow('Parameter $1 is outside the HUGEINT range');
  });

  it('binds null, strings, booleans, fractions and objects as before', () => {
    expect(recordBinds([null, undefined, 'eu-west-1', true, 3.14, Number.NaN, { a: 1 }])).toEqual([
      ['bindNull', 1],
      ['bindNull', 2],
      ['bindVarchar', 3, 'eu-west-1'],
      ['bindBoolean', 4, true],
      ['bindDouble', 5, 3.14],
      ['bindDouble', 6, Number.NaN],
      ['bindVarchar', 7, '{"a":1}'],
    ]);
  });
});

describe('bindParams against DuckDB', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  async function selectParam(sql: string, value: unknown): Promise<unknown> {
    const rows = await fetchRowsPrepared(conn, sql, [value]);
    return rows[0]?.['v'];
  }

  it.each<[string, unknown, unknown]>([
    ['2^31', 2 ** 31, 2n ** 31n],
    ['-(2^31)-1', -(2 ** 31) - 1, -(2n ** 31n) - 1n],
    ['2^40', 2 ** 40, 2n ** 40n],
    ['2^53+2 as a bigint', 2n ** 53n + 2n, 2n ** 53n + 2n],
    ['2^62 as a bigint', 2n ** 62n, 2n ** 62n],
    ['2^63 as a bigint', 2n ** 63n, 2n ** 63n],
  ])('round-trips %s exactly', async (_label, value, expected) => {
    expect(await selectParam('SELECT $1 AS v', value)).toBe(expected);
    expect(await selectParam('SELECT $1::HUGEINT AS v', value)).toBe(expected);
  });

  it('binds a wide integer where the SQL expects a BIGINT', async () => {
    expect(await selectParam('SELECT $1::BIGINT AS v', 2 ** 31)).toBe(2n ** 31n);
    const rows = await fetchRowsPrepared(conn, 'SELECT count(*)::INTEGER AS n FROM range(3) t(i) WHERE i + 3000000000 >= $1', [3000000001]);
    expect(rows[0]?.['n']).toBe(2);
  });

  it('binds an integral number past int64 as the same DOUBLE', async () => {
    expect(await selectParam('SELECT $1 AS v', 2 ** 63)).toBe(2 ** 63);
  });

  it.each<[string, unknown, unknown]>([
    ['an int32', 42, 42],
    ['a string', 'eu-west-1', 'eu-west-1'],
    ['a boolean', true, true],
    ['null', null, null],
    ['a double', 3.14, 3.14],
  ])('round-trips %s as before', async (_label, value, expected) => {
    expect(await selectParam('SELECT $1 AS v', value)).toBe(expected);
  });

  it('rejects a bigint past HUGEINT before running the query', async () => {
    await expect(fetchRowsPrepared(conn, 'SELECT $1 AS v', [2n ** 127n])).rejects.toThrow(RangeError);
  });
});
