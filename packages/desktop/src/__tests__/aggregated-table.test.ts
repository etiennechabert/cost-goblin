import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asProviderName, buildSource, QueryBuilder, SecurityError, tagSqlColumn, tagSqlColumnsById } from '@costgoblin/core';
import { parseRowKeys, queryAggregatedRows, rowKeysFilter } from '../main/handlers/aggregated-table.js';
import type { AggregatedRowsQuery, RunSql } from '../main/handlers/aggregated-table.js';
import { explorerGroupBy } from '../main/handlers/explorer-columns.js';
import { fetchRowsPrepared } from './helpers/duckdb-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__', 'synthetic');
// Literal mirror of FIXTURE_PROVIDER_NAME in packages/core/src/__fixtures__/layout.ts
// (not importable here — outside this package's tsconfig rootDir).
const FIXTURE_PROVIDER = asProviderName('aws-main');

const tagColumns = tagSqlColumnsById([{ tagName: 'stage' }]);
const STAGE = tagSqlColumn({ tagName: 'stage' });

describe('parseRowKeys', () => {
  it('passes no keys, and keys of string values, through', () => {
    expect(parseRowKeys(undefined, 10)).toBeUndefined();
    expect(parseRowKeys([], 10)).toEqual([]);
    expect(parseRowKeys([{ service: 'EC2', tag_stage: '' }], 10)).toEqual([{ service: 'EC2', tag_stage: '' }]);
  });

  it('refuses anything but a list of objects of string values', () => {
    for (const payload of [null, 'service=EC2', { service: 'EC2' }, [null], [['EC2']], [{ service: 3 }], [{ service: null }]]) {
      expect(() => parseRowKeys(payload, 10)).toThrow(SecurityError);
    }
  });

  it('refuses more keys than a result has rows', () => {
    expect(() => parseRowKeys([{}, {}, {}], 2)).toThrow(SecurityError);
  });
});

describe('rowKeysFilter', () => {
  const groupBy = explorerGroupBy(['service', 'tag_stage'], tagColumns);

  it('binds each key as one row of parameters, compared as the row values read the columns', () => {
    const qb = new QueryBuilder();
    expect(rowKeysFilter([{ service: 'EC2', tag_stage: "o'dev" }, { service: 'RDS', tag_stage: '' }], groupBy, qb)).toEqual({
      kind: 'some',
      condition: `row(COALESCE(CAST(service AS VARCHAR), ''), COALESCE(CAST(${STAGE} AS VARCHAR), '')) IN (row($1, $2), row($3, $4))`,
    });
    expect(qb.build().params).toEqual(['EC2', "o'dev", 'RDS', '']);
  });

  it('drops a key without a value for every group-by column', () => {
    const qb = new QueryBuilder();
    const filter = rowKeysFilter([{ service: 'EC2' }, { service: 'RDS', tag_stage: 'prod' }], groupBy, qb);
    expect(filter.kind === 'some' ? filter.condition : filter.kind).toMatch(/ IN \(row\(\$1, \$2\)\)$/);
    expect(qb.build().params).toEqual(['RDS', 'prod']);
    // An inherited property is not a value: `{}` has a `toString`.
    expect(rowKeysFilter([{}], [{ id: 'toString', column: 'service' }], new QueryBuilder())).toEqual({ kind: 'none' });
  });

  it('matches no group with an empty list, or with no usable key', () => {
    expect(rowKeysFilter([], groupBy, new QueryBuilder())).toEqual({ kind: 'none' });
    expect(rowKeysFilter([{ service: 'EC2' }], groupBy, new QueryBuilder())).toEqual({ kind: 'none' });
  });

  it('keeps every group without keys, and the one total row of a table with no group-by', () => {
    expect(rowKeysFilter(undefined, groupBy, new QueryBuilder())).toEqual({ kind: 'all' });
    expect(rowKeysFilter([{ service: 'EC2' }], [], new QueryBuilder())).toEqual({ kind: 'all' });
    expect(rowKeysFilter([], [], new QueryBuilder())).toEqual({ kind: 'none' });
  });
});

describe('queryAggregatedRows against DuckDB', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  const run: RunSql = (sql, params) => fetchRowsPrepared(conn, sql, params);

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    await conn.run(`
      CREATE TABLE line_items AS SELECT * FROM (VALUES
        ('EC2', 'eu-west-1', 10.0),
        ('EC2', 'us-east-1', 20.0),
        ('RDS', 'eu-west-1', 30.0),
        ('O''Brien', 'eu-west-1', 40.0),
        (NULL, 'eu-west-1', 50.0)
      ) AS t(service, region, cost)
    `);
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  const byServiceAndRegion: AggregatedRowsQuery = {
    source: '(SELECT *, cost AS list_cost, 1.0 AS usage_amount FROM line_items)',
    where: '',
    groupBy: explorerGroupBy(['service', 'region'], new Map()),
    sort: undefined,
    rowLimit: 500,
    rowKeys: undefined,
  };

  it('returns exactly the listed groups, matching every group-by column', async () => {
    const result = await queryAggregatedRows(run, {
      ...byServiceAndRegion,
      rowKeys: [{ service: 'EC2', region: 'us-east-1' }, { service: "O'Brien", region: 'eu-west-1' }],
    });
    expect(result.totalRows).toBe(2);
    expect(result.rows.map(r => [r.values, r.cost])).toEqual([
      [{ service: "O'Brien", region: 'eu-west-1' }, 40],
      [{ service: 'EC2', region: 'us-east-1' }, 20],
    ]);
  });

  it('matches a NULL group with an empty value, as its row reads', async () => {
    const result = await queryAggregatedRows(run, { ...byServiceAndRegion, rowKeys: [{ service: '', region: 'eu-west-1' }] });
    expect(result.rows.map(r => [r.values, r.cost])).toEqual([[{ service: '', region: 'eu-west-1' }, 50]]);
  });

  it('compares a key as a value, never as SQL', async () => {
    const result = await queryAggregatedRows(run, { ...byServiceAndRegion, rowKeys: [{ service: "x' OR '1'='1", region: 'eu-west-1' }] });
    expect(result).toEqual({ rows: [], totalRows: 0 });
  });

  it('runs nothing for keys that match no group', async () => {
    const neverRun: RunSql = () => Promise.reject(new Error('queried'));
    expect(await queryAggregatedRows(neverRun, { ...byServiceAndRegion, rowKeys: [] })).toEqual({ rows: [], totalRows: 0 });
    expect(await queryAggregatedRows(neverRun, { ...byServiceAndRegion, groupBy: [], rowKeys: [] })).toEqual({ rows: [], totalRows: 0 });
  });

  it('keeps the total row of a table with no group-by for any key', async () => {
    const result = await queryAggregatedRows(run, { ...byServiceAndRegion, groupBy: [], rowKeys: [{}] });
    expect(result.rows.map(r => [r.values, r.cost])).toEqual([[{}, 150]]);
  });

  describe('on the synthetic January bill', () => {
    // Usage, Tax ($250), Purchase ($120) and Credit (-$75), by charge category.
    const january: AggregatedRowsQuery = {
      source: buildSource({
        dataDir: SYNTHETIC_DIR,
        tier: 'daily',
        dimensions: { builtIn: [], tags: [] },
        providers: [{ name: FIXTURE_PROVIDER, periods: ['2026-01'] }],
      }),
      where: "WHERE usage_date BETWEEN '2026-01-01' AND '2026-01-31'",
      groupBy: explorerGroupBy(['charge_category'], new Map()),
      sort: undefined,
      rowLimit: 2,
      rowKeys: undefined,
    };

    it('returns the listed groups that the row limit cuts from the top groups by cost', async () => {
      const top = await queryAggregatedRows(run, january);
      expect(top.totalRows).toBe(4);
      expect(top.rows.map(r => r.values['charge_category'])).toEqual(['Usage', 'Tax']);

      const listed = await queryAggregatedRows(run, { ...january, rowKeys: [{ charge_category: 'Credit' }, { charge_category: 'Usage' }] });
      expect(listed.totalRows).toBe(2);
      expect(listed.rows.map(r => [r.values['charge_category'], r.cost])).toEqual([
        ['Usage', top.rows[0]?.cost],
        ['Credit', -75],
      ]);
    });
  });
});
