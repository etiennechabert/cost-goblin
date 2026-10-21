import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asBucketPath, asDimensionId, asProviderName } from '@costgoblin/core';
import type { CostGoblinConfig, DimensionsConfig } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { exploreData } from '../tools/explore-data.js';
import { getFilterValues } from '../tools/get-filter-values.js';
import { queryCosts } from '../tools/query-costs.js';
import { queryDailyCosts } from '../tools/query-daily-costs.js';
import { queryTrends } from '../tools/query-trends.js';
import { runSql } from '../tools/run-sql.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';
import type { JsonResult } from './helpers/json-result.js';

// Google's export leaves RegionId empty on multi-region and global charges and
// names the location in x_Location. Every tool an assistant uses must read
// that GCP spend under its location, not under a blank Region. The synthetic
// gcp-main provider has a US multi-region bucket (Cloud Storage) and global
// networking, and the rest in europe-west1.

const SYNTHETIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'src', '__fixtures__', 'synthetic');
const RANGE = { start: '2026-01-01', end: '2026-02-28' };
const FEB = { start: '2026-02-01', end: '2026-02-28' };
const REGIONS = ['europe-west1', 'global', 'us'];

const CONFIG: CostGoblinConfig = {
  providers: [{
    name: asProviderName('gcp-main'), type: 'gcp',
    sync: { daily: { bucket: asBucketPath('gs://b/focus/daily/'), retentionDays: 365 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'billed', lagDays: 1 },
};

const DIMENSIONS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
    { name: asDimensionId('pricing_category'), label: 'Pricing Category', field: 'pricing_category' },
  ],
  tags: [],
};

function table(result: JsonResult, titlePrefix?: string): readonly Readonly<Record<string, unknown>>[] {
  const found = titlePrefix === undefined
    ? result.tables[0]
    : result.tables.find(t => typeof t.title === 'string' && t.title.startsWith(titlePrefix));
  if (found === undefined) throw new Error(`no table "${String(titlePrefix)}"; have ${JSON.stringify(result.tables.map(t => t.title))}`);
  return found.rows;
}

function sorted(values: readonly unknown[]): unknown[] {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)));
}

describe('MCP tools over a GCP workspace', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let ctx: McpContext;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    ctx = {
      dataDir: SYNTHETIC_DIR,
      stateDir: SYNTHETIC_DIR,
      runQuery: (sql) => fetchRows(conn, sql),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
      getConfig: () => Promise.resolve(CONFIG),
      getDimensions: () => Promise.resolve(DIMENSIONS),
      getQueryDimensions: () => Promise.resolve(DIMENSIONS),
      getCostScope: () => Promise.resolve({ costMetric: 'billed', rules: [], lagDays: 1 }),
      getAccountMap: () => Promise.resolve(new Map<string, string>()),
      getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 20, 12),
    };
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  it('query_costs files the empty-RegionId spend under its location', async () => {
    const byRegion = parseJsonResult(resultText(await queryCosts(ctx, { groupBy: 'region', dateRange: RANGE, format: 'json' })));
    const regions = new Map(table(byRegion).map(r => [r['entity'], r['cost']]));
    expect(sorted([...regions.keys()])).toEqual(REGIONS);

    const byService = parseJsonResult(resultText(await queryCosts(ctx, { groupBy: 'service', dateRange: RANGE, format: 'json' })));
    const services = new Map(table(byService).map(r => [r['entity'], r['cost']]));
    expect(regions.get('us')).toBe(services.get('Cloud Storage'));
    expect(regions.get('global')).toBe(services.get('Networking'));
  });

  it('query_daily_costs and query_trends group by the same locations', async () => {
    const daily = parseJsonResult(resultText(await queryDailyCosts(ctx, { groupBy: 'region', dateRange: FEB, format: 'json' })));
    const groups = (daily.tables[0]?.columnKeys ?? []).filter(k => k.startsWith('grp_')).map(k => k.slice('grp_'.length));
    expect(sorted(groups)).toEqual(REGIONS);

    const trends = parseJsonResult(resultText(await queryTrends(ctx, {
      groupBy: 'region', dateRange: FEB, deltaThreshold: 0, percentThreshold: 0, format: 'json',
    })));
    expect(sorted(table(trends, 'Top Increases').map(r => r['entity']))).toEqual(REGIONS);
  });

  it('get_filter_values and explore_data list the locations as Region values', async () => {
    const values = parseJsonResult(resultText(await getFilterValues(ctx, { dimensionId: 'region', dateRange: RANGE, format: 'json' })));
    expect(sorted(table(values).map(r => r['value']))).toEqual(REGIONS);

    const explored = parseJsonResult(resultText(await exploreData(ctx, { dateRange: RANGE, groupByColumns: ['region'], format: 'json' })));
    expect(sorted(table(explored).map(r => r['region']))).toEqual(REGIONS);
  });

  it('run_sql reads the location and the FOCUS pricing category off the costs table', async () => {
    const regions = parseJsonResult(resultText(await runSql(ctx, { sql: 'SELECT DISTINCT region FROM costs', dateRange: RANGE, format: 'json' })));
    expect(sorted(table(regions).map(r => r['region']))).toEqual(REGIONS);

    // The export writes 'standard'; FOCUS and AWS write 'Standard'.
    const pricing = parseJsonResult(resultText(await runSql(ctx, {
      sql: 'SELECT DISTINCT pricing_category FROM costs ORDER BY 1', dateRange: RANGE, format: 'json',
    })));
    expect(table(pricing).map(r => r['pricing_category'])).toEqual(['', 'Committed', 'Standard']);
  });
});
