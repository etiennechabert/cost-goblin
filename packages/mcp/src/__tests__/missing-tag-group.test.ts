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
import { queryTrends } from '../tools/query-trends.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';
import type { JsonResult } from './helpers/json-result.js';

// query_costs and query_trends grouped by a tag, on Parquet holding an
// empty-valued tag, a missing one and a set one. The rows read a missing tag
// as '', so both kinds of rows with no value are one '' group, as a filter on
// '' keeps them: a group dropped there misstates the total.

const JAN = { start: '2026-01-01', end: '2026-01-31' };
const EC2 = 'Amazon Elastic Compute Cloud';
const S3 = 'Amazon Simple Storage Service';
// One power of two per row, so each figure names the rows it counts.
const COST = { emptyTag: 8, untagged: 4, tagged: 1 } as const;

const CONFIG: CostGoblinConfig = {
  providers: [{
    name: asProviderName('aws'), type: 'aws', credentialsProfile: 'default',
    sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 90 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

const DIMENSIONS: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [{ tagName: 'team', label: 'Team' }],
};

function tableOf(result: JsonResult, titlePrefix: string | undefined): readonly Readonly<Record<string, unknown>>[] {
  const table = result.tables.find(t => (titlePrefix === undefined ? t.title === undefined : typeof t.title === 'string' && t.title.startsWith(titlePrefix)));
  if (table === undefined) throw new Error(`no table "${String(titlePrefix)}"; have ${JSON.stringify(result.tables.map(t => t.title))}`);
  return table.rows;
}

describe('a tag group-by with rows that have no value', () => {
  let root: string;
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let ctx: McpContext;

  beforeAll(async () => {
    root = (await mkdtemp(join(tmpdir(), 'cg-mcp-missing-tag-'))).replaceAll('\\', '/');
    const monthDir = join(root, 'aws', 'raw', 'daily-2026-01');
    await mkdir(monthDir, { recursive: true });
    db = await DuckDBInstance.create();
    conn = await db.connect();
    const row = (service: string, code: string, cost: number, tags: string): string =>
      `(TIMESTAMP '2026-01-05 00:00:00', '111', 'Acct', 'eu-west-1', '${service}', '${code}', 'Compute', 'usage',
        1.0, ${String(cost)}::DOUBLE, ${String(cost)}::DOUBLE, 'arn:res', ${String(cost)}::DOUBLE,
        'Usage', 'Standard', '', 'Op', 'Meter', ${tags})`;
    await conn.run(`
      COPY (
        SELECT * FROM (VALUES
          ${row(EC2, 'AmazonEC2', COST.emptyTag, "MAP {'team': ''}")},
          ${row(S3, 'AmazonS3', COST.untagged, "MAP {'env': 'prod'}")},
          ${row(EC2, 'AmazonEC2', COST.tagged, "MAP {'team': 'a'}")}
        ) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
               ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
               ConsumedQuantity, ListCost, BilledCost, ResourceId, EffectiveCost,
               ChargeCategory, PricingCategory, CommitmentDiscountStatus,
               x_Operation, SkuMeter, Tags)
      ) TO ${sqlStringLiteral(join(monthDir, 'data.parquet').replaceAll('\\', '/'))} (FORMAT PARQUET)
    `);

    ctx = {
      dataDir: root,
      stateDir: root,
      runQuery: (sql) => fetchRows(conn, sql),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
      getConfig: () => Promise.resolve(CONFIG),
      getDimensions: () => Promise.resolve(DIMENSIONS),
      getQueryDimensions: () => Promise.resolve(DIMENSIONS),
      getCostScope: () => Promise.resolve({ costMetric: 'effective', rules: [] }),
      getAccountMap: () => Promise.resolve(new Map<string, string>()),
      getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => Date.UTC(2026, 1, 20, 12),
    };
  });

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(root, { recursive: true, force: true });
  });

  it("query_costs totals both under one '' row, with the services of each", async () => {
    const result = parseJsonResult(resultText(await queryCosts(ctx, { groupBy: 'tag_team', dateRange: JAN, format: 'json' })));
    const total = COST.emptyTag + COST.untagged + COST.tagged;
    expect(result.meta.get('Total')).toBe(total);
    const noValue = COST.emptyTag + COST.untagged;
    expect(tableOf(result, undefined)).toEqual([
      { entity: '', cost: noValue, pct: (noValue / total) * 100, [`svc_${EC2}`]: COST.emptyTag, [`svc_${S3}`]: COST.untagged },
      { entity: 'a', cost: COST.tagged, pct: (COST.tagged / total) * 100, [`svc_${EC2}`]: COST.tagged, [`svc_${S3}`]: 0 },
    ]);
  });

  it("query_trends reports both as one '' row", async () => {
    const result = parseJsonResult(resultText(await queryTrends(ctx, { groupBy: 'tag_team', dateRange: JAN, format: 'json' })));
    expect(tableOf(result, 'Top Increases').map(r => [r['entity'], r['current'], r['previous']])).toEqual([
      ['', COST.emptyTag + COST.untagged, 0],
      ['a', COST.tagged, 0],
    ]);
  });
});
