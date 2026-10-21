import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asBucketPath, asDimensionId, asProviderName, sqlStringLiteral } from '@costgoblin/core';
import type { CostGoblinConfig, DimensionsConfig } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { queryCosts } from '../tools/query-costs.js';
import { queryDailyCosts } from '../tools/query-daily-costs.js';
import { queryTrends } from '../tools/query-trends.js';
import { runSql } from '../tools/run-sql.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';
import type { JsonResult } from './helpers/json-result.js';

// The tools an assistant compares must count the same rows for one range.
// AWS writes ChargePeriodStart tz-aware, and a DuckDB session outside UTC
// used to date it by its local day: query_trends, which also reads the
// previous period's month, then counted rows that query_costs did not.

const EC2 = 'Amazon Elastic Compute Cloud';
const RANGE = { start: '2026-10-01', end: '2026-10-14' };

// One power of two per row; `start` is UTC (see the core suite of the same
// name for where each one used to land).
const ROWS = [
  { month: '2026-09', start: '2026-09-16 23:00:00', cost: 1 },
  { month: '2026-09', start: '2026-09-17 00:00:00', cost: 2 },
  { month: '2026-09', start: '2026-09-30 23:00:00', cost: 4 },
  { month: '2026-10', start: '2026-10-01 00:00:00', cost: 8 },
  { month: '2026-10', start: '2026-10-01 05:00:00', cost: 16 },
  { month: '2026-10', start: '2026-10-14 23:00:00', cost: 32 },
  { month: '2026-10', start: '2026-10-15 03:00:00', cost: 64 },
  { month: '2026-10', start: '2026-10-15 23:00:00', cost: 128 },
] as const;
const IN_RANGE = 8 + 16 + 32;
const IN_PREVIOUS = 2 + 4;

const CONFIG: CostGoblinConfig = {
  providers: [{
    name: asProviderName('aws'), type: 'aws', credentialsProfile: 'default',
    sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 90 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

const DIMENSIONS: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};

function onlyTable(result: JsonResult, titlePrefix?: string): readonly Readonly<Record<string, unknown>>[] {
  const table = titlePrefix === undefined
    ? result.tables[0]
    : result.tables.find(t => typeof t.title === 'string' && t.title.startsWith(titlePrefix));
  if (table === undefined) throw new Error(`no table "${String(titlePrefix)}"; have ${JSON.stringify(result.tables.map(t => t.title))}`);
  return table.rows;
}

describe.each(['America/Los_Angeles', 'Europe/Berlin'])('MCP cost tools with the DuckDB session in %s', (zone) => {
  let root: string;
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let ctx: McpContext;

  beforeAll(async () => {
    root = (await mkdtemp(join(tmpdir(), 'cg-mcp-utc-days-'))).replaceAll('\\', '/');
    db = await DuckDBInstance.create(':memory:', { TimeZone: zone });
    conn = await db.connect();
    for (const month of ['2026-09', '2026-10']) {
      const dir = join(root, 'aws', 'raw', `daily-${month}`);
      await mkdir(dir, { recursive: true });
      const values = ROWS.filter(r => r.month === month).map(r =>
        `(TIMESTAMPTZ '${r.start}+00', '111', 'Acct', 'eu-west-1', '${EC2}', 'AmazonEC2', 'Compute', 'usage',
          1.0, ${String(r.cost)}::DOUBLE, ${String(r.cost)}::DOUBLE, 'arn:res', ${String(r.cost)}::DOUBLE,
          'Usage', 'Standard', '', 'RunInstances', 'BoxUsage', MAP {'team': 'core'})`);
      await conn.run(`
        COPY (
          SELECT * FROM (VALUES ${values.join(',\n')}) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
                 ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
                 ConsumedQuantity, ListCost, BilledCost, ResourceId, EffectiveCost,
                 ChargeCategory, PricingCategory, CommitmentDiscountStatus,
                 x_Operation, SkuMeter, Tags)
        ) TO ${sqlStringLiteral(join(dir, 'data.parquet').replaceAll('\\', '/'))} (FORMAT PARQUET)
      `);
    }

    ctx = {
      dataDir: root,
      stateDir: root,
      runQuery: (sql) => fetchRows(conn, sql),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
      getConfig: () => Promise.resolve(CONFIG),
      getDimensions: () => Promise.resolve(DIMENSIONS),
      getQueryDimensions: () => Promise.resolve(DIMENSIONS),
      getCostScope: () => Promise.resolve({ costMetric: 'effective', rules: [], lagDays: 2 }),
      getAccountMap: () => Promise.resolve(new Map<string, string>()),
      getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 20, 12),
    };
  });

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(root, { recursive: true, force: true });
  });

  it('query_costs and query_trends count the same rows for the range', async () => {
    const costs = parseJsonResult(resultText(await queryCosts(ctx, { groupBy: 'service', dateRange: RANGE, format: 'json' })));
    expect(costs.meta.get('Total')).toBe(IN_RANGE);

    const trends = parseJsonResult(resultText(await queryTrends(ctx, {
      groupBy: 'service', dateRange: RANGE, deltaThreshold: 0, percentThreshold: 0, format: 'json',
    })));
    expect(onlyTable(trends, 'Top Increases').map(r => [r['entity'], r['current'], r['previous']])).toEqual([[EC2, IN_RANGE, IN_PREVIOUS]]);
  });

  it('query_daily_costs puts the rows on their UTC days', async () => {
    const daily = parseJsonResult(resultText(await queryDailyCosts(ctx, { groupBy: 'service', dateRange: RANGE, format: 'json' })));
    expect(daily.meta.get('Total')).toBe(IN_RANGE);
    expect(onlyTable(daily).map(r => [r['date'], r['total']])).toEqual([['2026-10-01', 8 + 16], ['2026-10-14', 32]]);
  });

  it('run_sql reads the same UTC days from the costs table', async () => {
    const result = parseJsonResult(resultText(await runSql(ctx, {
      sql: 'SELECT usage_date, SUM(cost) AS c FROM costs GROUP BY usage_date ORDER BY usage_date',
      dateRange: RANGE,
      format: 'json',
    })));
    expect(onlyTable(result).map(r => [r['usage_date'], r['c']])).toEqual([['2026-10-01', 8 + 16], ['2026-10-14', 32]]);
  });

  it('reports the latest UTC day in the coverage banner', async () => {
    const costs = parseJsonResult(resultText(await queryCosts(ctx, { groupBy: 'service', dateRange: RANGE, format: 'json' })));
    expect(costs.coverage?.['latestDay']).toBe('2026-10-15');
  });
});
