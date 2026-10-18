import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asProviderName, buildSource, QueryBuilder, SecurityError, sqlStringLiteral, tagDimColumn, tagSqlColumn, tagSqlColumnsById } from '@costgoblin/core';
import type { DimensionsConfig, TagDimension } from '@costgoblin/core';
import { parseRowFilters, parseRowKeys, queryAggregatedRows, rowKeysFilter } from '../main/handlers/aggregated-table.js';
import type { AggregatedRowsQuery, RunSql } from '../main/handlers/aggregated-table.js';
import { explorerGroupBy, explorerRowFilters } from '../main/handlers/explorer-columns.js';
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

describe('parseRowFilters', () => {
  it('passes no filters, and filters of string values, through', () => {
    expect(parseRowFilters(undefined)).toBeUndefined();
    expect(parseRowFilters({ service: "O'Brien", tag_stage: '' })).toEqual({ service: "O'Brien", tag_stage: '' });
  });

  it('refuses anything but an object of string values', () => {
    for (const payload of [null, 'service=EC2', ['EC2'], { service: 3 }, { service: null }, { service: ['EC2'] }]) {
      expect(() => parseRowFilters(payload)).toThrow(SecurityError);
    }
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
  // Cloned, as the rows reach the main process: the DuckDB worker posts
  // them, and a DATE or TIMESTAMP value arrives as a plain object.
  const run: RunSql = async (sql, params) => structuredClone(await fetchRowsPrepared(conn, sql, params));

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
    rowFilters: [],
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

  it('counts the groups only when a keyed page is full', async () => {
    const queries: string[] = [];
    const recording: RunSql = (sql, params) => { queries.push(sql); return run(sql, params); };
    const counts = (): number => queries.filter(sql => sql.includes('AS _cnt')).length;
    const rowKeys = [{ service: 'EC2', region: 'us-east-1' }, { service: 'RDS', region: 'eu-west-1' }];

    expect((await queryAggregatedRows(recording, { ...byServiceAndRegion, rowKeys })).totalRows).toBe(2);
    expect(counts()).toBe(0);

    const full = await queryAggregatedRows(recording, { ...byServiceAndRegion, rowKeys, rowLimit: 1 });
    expect([full.rows.length, full.totalRows]).toEqual([1, 2]);
    expect(counts()).toBe(1);
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

  it('keeps the line items a row filter matches, comparing its value as a value', async () => {
    const expanded = await queryAggregatedRows(run, { ...byServiceAndRegion, rowFilters: explorerRowFilters({ service: "O'Brien" }, new Map()) });
    expect(expanded.totalRows).toBe(1);
    expect(expanded.rows.map(r => [r.values, r.cost])).toEqual([[{ service: "O'Brien", region: 'eu-west-1' }, 40]]);

    const injected = await queryAggregatedRows(run, { ...byServiceAndRegion, rowFilters: explorerRowFilters({ service: "x' OR '1'='1" }, new Map()) });
    expect(injected).toEqual({ rows: [], totalRows: 0 });
  });

  it('applies the row filters and the keys together, numbering their values in WHERE order', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const recording: RunSql = (sql, params) => { calls.push({ sql, params }); return run(sql, params); };
    // RDS is a listed key the row filter rules out.
    const result = await queryAggregatedRows(recording, {
      ...byServiceAndRegion,
      rowFilters: explorerRowFilters({ service: "O'Brien" }, new Map()),
      rowKeys: [{ service: 'RDS', region: 'eu-west-1' }, { service: "O'Brien", region: 'eu-west-1' }],
    });
    expect(result.totalRows).toBe(1);
    expect(result.rows.map(r => [r.values, r.cost])).toEqual([[{ service: "O'Brien", region: 'eu-west-1' }, 40]]);

    const [data] = calls;
    expect(calls).toHaveLength(1);
    expect(data?.sql).toContain(`WHERE service = $1 AND row(COALESCE(CAST(service AS VARCHAR), ''), COALESCE(CAST(region AS VARCHAR), '')) IN (row($2, $3), row($4, $5))`);
    expect(data?.params).toEqual(["O'Brien", 'RDS', 'eu-west-1', "O'Brien", 'eu-west-1']);
  });

  it('extends the WHERE every line item passes', async () => {
    const result = await queryAggregatedRows(run, {
      ...byServiceAndRegion,
      where: "WHERE region = 'eu-west-1'",
      rowFilters: explorerRowFilters({ service: 'EC2' }, new Map()),
    });
    expect(result.rows.map(r => [r.values, r.cost])).toEqual([[{ service: 'EC2', region: 'eu-west-1' }, 10]]);
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
      rowFilters: [],
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

    it('expands a day group through a row filter on the date its row reads', async () => {
      const days = await queryAggregatedRows(run, { ...january, groupBy: explorerGroupBy(['usage_date'], new Map()), rowLimit: 1 });
      const [day] = days.rows;
      if (day === undefined) throw new Error('expected a day of January');
      expect(day.values['usage_date']).toMatch(/^2026-01-\d\d$/);

      const detail = await queryAggregatedRows(run, { ...january, rowFilters: explorerRowFilters(day.values, new Map()), rowLimit: 500 });
      expect(detail.rows.length).toBeGreaterThan(0);
      expect(detail.rows.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(day.cost, 6);
    });
  });

  describe('on line items whose team tag is missing, empty or set', () => {
    const TEAM: TagDimension = { tagName: 'team', label: 'Team' };
    const TEAM_ID = tagDimColumn(TEAM);
    const dimensions: DimensionsConfig = { builtIn: [], tags: [TEAM] };
    let dataDir = '';

    beforeAll(async () => {
      dataDir = (await mkdtemp(join(tmpdir(), 'cg-agg-tags-'))).replaceAll('\\', '/');
      // One power of two per line item, so every total names its items.
      const item = (hour: string, service: string, tags: string, cost: number): string =>
        `(TIMESTAMP '2026-01-05 ${hour}:00:00', '111', 'Acct', 'eu-west-1', '${service}', '${service}', 'Compute', 'usage',
          1.0, ${String(cost)}, 'arn:${String(cost)}', ${String(cost)}, 'Usage', 'Standard', '', 'RunInstances', 'BoxUsage', ${tags})`;
      const items = [
        item('05', 'EC2', "MAP {'team': 'web'}", 1),
        item('05', 'EC2', "MAP {'env': 'prod'}", 2),
        item('06', 'EC2', "MAP {'team': ''}", 4),
        item('06', 'RDS', "MAP {'team': ''}", 8),
        item('06', 'RDS', "MAP {'env': 'dev'}", 16),
      ];
      for (const tier of ['daily', 'hourly']) {
        const dir = join(dataDir, FIXTURE_PROVIDER, 'raw', `${tier}-2026-01`);
        await mkdir(dir, { recursive: true });
        await conn.run(`
          COPY (
            SELECT * FROM (VALUES ${items.join(',\n')}) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
              ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription, ConsumedQuantity, ListCost, ResourceId,
              EffectiveCost, ChargeCategory, PricingCategory, CommitmentDiscountStatus, x_Operation, SkuMeter, Tags)
          ) TO ${sqlStringLiteral(join(dir, 'data.parquet').replaceAll('\\', '/'))} (FORMAT PARQUET)
        `);
      }
    });

    afterAll(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });

    const query = (tier: 'daily' | 'hourly', ids: readonly string[]): AggregatedRowsQuery => ({
      source: buildSource({ dataDir, tier, dimensions, providers: [{ name: FIXTURE_PROVIDER, periods: ['2026-01'] }], costMetric: 'effective' }),
      where: '',
      groupBy: explorerGroupBy(ids, tagSqlColumnsById(dimensions.tags)),
      rowFilters: [],
      sort: undefined,
      rowLimit: 500,
      rowKeys: undefined,
    });

    it('shows a missing and an empty tag as one group, counted once', async () => {
      const result = await queryAggregatedRows(run, query('daily', ['service', TEAM_ID]));
      expect(result.totalRows).toBe(3);
      expect(result.rows.map(r => [r.values, r.cost, r.rowCount])).toEqual([
        [{ service: 'RDS', [TEAM_ID]: '' }, 24, 2],
        [{ service: 'EC2', [TEAM_ID]: '' }, 6, 2],
        [{ service: 'EC2', [TEAM_ID]: 'web' }, 1, 1],
      ]);
    });

    it('returns that group whole for a key with an empty value', async () => {
      const result = await queryAggregatedRows(run, { ...query('daily', ['service', TEAM_ID]), rowKeys: [{ service: 'EC2', [TEAM_ID]: '' }] });
      expect(result.totalRows).toBe(1);
      expect(result.rows.map(r => [r.values, r.cost])).toEqual([[{ service: 'EC2', [TEAM_ID]: '' }, 6]]);
    });

    it('sorts by the tag as it reads', async () => {
      const teams = async (direction: 'asc' | 'desc'): Promise<string[]> => {
        const result = await queryAggregatedRows(run, { ...query('daily', [TEAM_ID]), sort: { column: TEAM_ID, direction } });
        return result.rows.map(r => r.values[TEAM_ID] ?? '?');
      };
      expect(await teams('asc')).toEqual(['', 'web']);
      expect(await teams('desc')).toEqual(['web', '']);
    });

    it('reads a date or an hour as text, and keys and sorts it by that text', async () => {
      const byDate = await queryAggregatedRows(run, query('daily', ['usage_date']));
      expect(byDate.rows.map(r => [r.values, r.cost])).toEqual([[{ usage_date: '2026-01-05' }, 31]]);

      const byHour = query('hourly', ['usage_hour']);
      expect((await queryAggregatedRows(run, byHour)).rows.map(r => [r.values, r.cost])).toEqual([
        [{ usage_hour: '2026-01-05 06:00:00' }, 28],
        [{ usage_hour: '2026-01-05 05:00:00' }, 3],
      ]);
      const keyed = await queryAggregatedRows(run, { ...byHour, rowKeys: [{ usage_hour: '2026-01-05 05:00:00' }] });
      expect(keyed.rows.map(r => r.cost)).toEqual([3]);
      const ascending = await queryAggregatedRows(run, { ...byHour, sort: { column: 'usage_hour', direction: 'asc' } });
      expect(ascending.rows.map(r => r.values['usage_hour'])).toEqual(['2026-01-05 05:00:00', '2026-01-05 06:00:00']);
    });
  });
});
