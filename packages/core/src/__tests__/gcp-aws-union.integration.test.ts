import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeGcpPeriod } from '../sync/gcp-canonicalize.js';
import { buildSource, buildCostQuery, resolveField } from '../query/builder.js';
import type { ProviderSourceBranch } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDateString, asDimensionId, asProviderName } from '../types/branded.js';

/**
 * Layer 2: one query over a workspace holding BOTH provider shapes.
 *
 * The pieces were each covered alone — the canonicalizer against
 * BigQuery-shaped Parquet, and `buildSource` over two *identically shaped* AWS
 * branches. Neither exercises the case the app actually hits once a GCP
 * provider is added beside an AWS one: `buildSource` unioning a canonicalized
 * GCP file with a native AWS export.
 *
 * The two shapes genuinely differ. GCP's export has no `ServiceCategory`,
 * `CommitmentDiscountStatus`, `x_ServiceCode`, `x_Operation` or `SkuMeter`
 * columns and no `Tags` at all; the canonicalizer synthesizes or NULLs each
 * one, and carries ~30 extra `x_` columns the AWS side has never heard of. If
 * any of that is wrong the failure is a DuckDB binder error at query time —
 * i.e. the whole app, not one view.
 *
 * The GCP branch here is produced by running the real canonicalizer, not by
 * hand-writing what it is assumed to emit.
 */

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

const AWS = asProviderName('aws-main');
const GCP = asProviderName('gcp-main');
const PERIOD = '2026-01';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('provider'), label: 'Provider', field: 'provider' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
    { name: asDimensionId('service_category'), label: 'Service Category', field: 'service_category' },
  ],
  // A tag dimension's id is derived from its key, not declared — `team`
  // resolves as `tag_team`.
  tags: [{ label: 'Team', tagName: 'team' }],
};

/** BigQuery's delivered shape: tz-aware timestamps, DECIMAL costs, tags as a
 *  repeated struct, `x_ServiceId`/`SkuId` in place of the AWS extensions. */
const BQ_COLUMNS = `
  ChargePeriodStart, SubAccountId, SubAccountName,
  BilledCost, EffectiveCost, ListCost, ContractedCost,
  ServiceName, RegionId, ResourceId, ChargeCategory, PricingCategory,
  ChargeDescription, ConsumedQuantity,
  x_Tags, x_Labels, x_ServiceId, SkuId, x_ExportTime`;

const NO_LABELS = `CAST(NULL AS STRUCT("Key" VARCHAR, "Value" VARCHAR)[])`;

function bqRow(opts: { day: string; project: string; service: string; billed: number; effective: number; team: string }): string {
  return `(
    TIMESTAMPTZ '2026-01-${opts.day} 12:00:00+00',
    '${opts.project}', 'Project ${opts.project}',
    CAST(${String(opts.billed)} AS DECIMAL(38,9)), CAST(${String(opts.effective)} AS DECIMAL(38,9)),
    CAST(${String(opts.billed * 2)} AS DECIMAL(38,9)), CAST(${String(opts.billed)} AS DECIMAL(38,9)),
    '${opts.service}', 'europe-west1', '//compute/instances/x', 'Usage', 'Standard',
    'N1 Predefined Instance Core', CAST(24 AS DECIMAL(38,9)),
    [{'Key': 'team', 'Value': '${opts.team}', 'x_Inherited': false, 'x_Namespace': ''}], ${NO_LABELS},
    'compute.googleapis.com', 'N1-Standard-Core', TIMESTAMPTZ '2026-02-02 04:00:00+00'
  )`;
}

let conn: Conn;
let ownedInstance: DuckDBInstance | null = null;
let dataDir: string;

async function rowsOf(sql: string): Promise<Record<string, unknown>[]> {
  const result = await conn.run(sql);
  return result.getRowObjects();
}

/** One AWS period, in the native FOCUS 1.2 Data Export shape: MAP tags,
 *  DOUBLE costs, naive timestamps, extension columns present. */
async function seedAws(rows: readonly { account: string; service: string; billed: number; effective: number; team: string }[]): Promise<void> {
  const partDir = join(dataDir, String(AWS), 'raw', `daily-${PERIOD}`);
  await mkdir(partDir, { recursive: true });
  const values = rows.map(r => `(
    TIMESTAMP '2026-01-15', '${r.account}', 'Account ${r.account}', 'eu-central-1',
    '${r.service}', '${r.service}', 'Compute', 'row', CAST(1 AS DOUBLE),
    CAST(${String(r.billed * 2)} AS DOUBLE), 'res',
    CAST(${String(r.billed)} AS DOUBLE), CAST(${String(r.effective)} AS DOUBLE), CAST(${String(r.billed)} AS DOUBLE),
    'Usage', 'Standard', '', 'Op', 'SKU', MAP{'team':'${r.team}'}
  )`).join(',');
  await conn.run(`CREATE TABLE aws_src AS SELECT * FROM (VALUES ${values}) AS t(
    ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
    ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription, ConsumedQuantity,
    ListCost, ResourceId, BilledCost, EffectiveCost, ContractedCost,
    ChargeCategory, PricingCategory, CommitmentDiscountStatus, x_Operation, SkuMeter, Tags)`);
  await conn.run(`COPY (SELECT * FROM aws_src) TO '${join(partDir, 'data.parquet')}' (FORMAT PARQUET)`);
}

/** One GCP period, staged as BigQuery writes it and then put through the real
 *  canonicalizer into the raw/ layout the query layer globs. */
async function seedGcp(rows: readonly string[]): Promise<void> {
  const staging = join(dataDir, 'staging-gcp', PERIOD);
  await mkdir(staging, { recursive: true });
  await conn.run(`CREATE TABLE bq_src AS SELECT * FROM (VALUES ${rows.join(',')}) AS t(${BQ_COLUMNS})`);
  await conn.run(`COPY (SELECT * FROM bq_src) TO '${join(staging, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);

  const partDir = join(dataDir, String(GCP), 'raw', `daily-${PERIOD}`);
  await mkdir(partDir, { recursive: true });
  await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: join(partDir, 'part-0.parquet'), connection: conn });
}

function branches(): ProviderSourceBranch[] {
  return [
    { name: AWS, periods: [PERIOD] },
    { name: GCP, periods: [PERIOD] },
  ];
}

function source(costMetric: 'billed' | 'effective' = 'billed'): string {
  return buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cg-gcp-aws-'));
  const instance = await DuckDBInstance.create();
  ownedInstance = instance;
  conn = await instance.connect();
  // East of UTC on purpose: `::DATE` resolves in the SESSION timezone, so an
  // un-normalized GCP timestamp would land on the wrong day here.
  await conn.run(`SET TimeZone='Europe/Berlin'`);

  await seedAws([
    { account: '111111111111', service: 'AmazonEC2', billed: 100, effective: 80, team: 'platform' },
    { account: '222222222222', service: 'AmazonS3', billed: 50, effective: 50, team: 'data-eng' },
  ]);
  await seedGcp([
    bqRow({ day: '14', project: 'proj-a', service: 'Compute Engine', billed: 30, effective: 20, team: 'platform' }),
    bqRow({ day: '16', project: 'proj-b', service: 'Cloud Storage', billed: 7, effective: 7, team: 'data-eng' }),
  ]);
});

afterAll(() => {
  conn.disconnectSync();
  ownedInstance?.closeSync();
  ownedInstance = null;
});

describe('aws + gcp in one union (DuckDB end-to-end)', () => {
  it('sums both shapes into one total', async () => {
    const rows = await rowsOf(`SELECT SUM(cost) AS cost FROM ${source()}`);
    expect(rows).toEqual([{ cost: 187 }]); // 100 + 50 + 30 + 7
  });

  it('attributes each row to its own provider', async () => {
    const rows = await rowsOf(`SELECT provider, SUM(cost) AS cost FROM ${source()} GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'aws-main', cost: 150 },
      { provider: 'gcp-main', cost: 37 },
    ]);
  });

  it('resolves one tag expression across MAP-native and canonicalized tags', async () => {
    // AWS delivers Tags as a Parquet MAP; GCP has no Tags column at all and
    // the canonicalizer builds one from x_Tags/x_Labels. `element_at` compiles
    // against a MAP only, so a shape mismatch is a binder error, not a wrong
    // number.
    const { fieldExpr } = resolveField(asDimensionId('tag_team'), dimensions);
    const rows = await rowsOf(`SELECT ${fieldExpr} AS team, SUM(cost) AS cost FROM ${source()} GROUP BY 1 ORDER BY 1`);
    expect(rows).toEqual([
      { team: 'data-eng', cost: 57 },  // 50 aws + 7 gcp
      { team: 'platform', cost: 130 }, // 100 aws + 30 gcp
    ]);
  });

  it('prices each branch from its own cost columns', async () => {
    // The GCP costs arrive as DECIMAL and are cast to DOUBLE by the
    // canonicalizer; a union that priced one branch from the other's rows —
    // or lost precision in the cast — would misreport exactly one provider.
    const rows = await rowsOf(`SELECT provider, SUM(cost) AS cost FROM ${source('effective')} GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'aws-main', cost: 130 }, // 80 + 50
      { provider: 'gcp-main', cost: 27 },  // 20 + 7
    ]);
  });

  it('keeps GCP rows in the right day under a non-UTC session timezone', async () => {
    const rows = await rowsOf(`SELECT usage_date::VARCHAR AS d, SUM(cost) AS cost
      FROM ${source()} WHERE provider = 'gcp-main' GROUP BY 1 ORDER BY 1`);
    expect(rows).toEqual([
      { d: '2026-01-14', cost: 30 },
      { d: '2026-01-16', cost: 7 },
    ]);
  });

  it('groups by a dimension GCP does not have, without dropping its rows', async () => {
    // ServiceCategory does not exist in the GCP export. The canonicalizer
    // materializes it rather than omitting it — a column absent from every
    // file on one branch is a binder error, not a NULL fill — and it lands as
    // the empty string, which is what the dimension picker renders as a single
    // blank value. The GCP spend must still be reachable under it.
    const { fieldExpr } = resolveField(asDimensionId('service_category'), dimensions);
    const rows = await rowsOf(`SELECT ${fieldExpr} AS cat, SUM(cost) AS cost
      FROM ${source()} GROUP BY 1 ORDER BY 2 DESC`);
    expect(rows).toEqual([
      { cat: 'Compute', cost: 150 },
      { cat: '', cost: 37 },
    ]);
  });

  it('filters to one provider like any other dimension', async () => {
    const { fieldExpr } = resolveField(asDimensionId('provider'), dimensions);
    const rows = await rowsOf(`SELECT SUM(cost) AS cost FROM ${source()} WHERE ${fieldExpr} = 'gcp-main'`);
    expect(rows).toEqual([{ cost: 37 }]);
  });

  it('serves a real buildCostQuery over the mixed workspace', async () => {
    // The full path the app takes, parameters and all — not just buildSource.
    const { sql, params } = buildCostQuery(
      {
        groupBy: asDimensionId('provider'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        granularity: 'daily',
      },
      {
        dataDir, dimensions,
        providers: [
          { name: AWS, availablePeriods: [PERIOD] },
          { name: GCP, availablePeriods: [PERIOD] },
        ],
      },
    );
    const prepared = await conn.prepare(sql);
    let i = 1;
    for (const p of params) {
      if (typeof p === 'number') prepared.bindDouble(i, p);
      else prepared.bindVarchar(i, String(p));
      i += 1;
    }
    const result = await prepared.run();
    const rows = await result.getRowObjects();
    // buildCostQuery defaults to the 'effective' metric: aws 80 + 50,
    // gcp 20 + 7 — each branch priced from its own columns.
    const byEntity = new Map(rows.map(r => [String(r['entity']), Number(r['total_cost'])]));
    expect([...byEntity.keys()].sort()).toEqual(['aws-main', 'gcp-main']);
    expect(byEntity.get('aws-main')).toBeCloseTo(130, 6);
    expect(byEntity.get('gcp-main')).toBeCloseTo(27, 6);
  });
});
