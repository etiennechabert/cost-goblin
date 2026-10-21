import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCostQuery, buildDailyCostsQuery, buildSource, buildTrendQuery } from '../query/builder.js';
import type { ProviderSourceSpec, QueryContextOptions } from '../query/builder.js';
import { canonicalizeGcpPeriod } from '../sync/gcp-canonicalize.js';
import { FIXTURE_GCP_PROVIDER_NAME, FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import { writeSampleParquet } from '../__fixtures__/focus-1-2/load.js';
import { SAMPLE_MONTH } from '../__fixtures__/focus-1-2/samples.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDateString, asDimensionId, asDollars, asProviderName } from '../types/branded.js';

/**
 * Layer 2: what Region and Pricing Category read on GCP rows.
 *
 * Google's FOCUS export leaves RegionId empty on multi-region and global
 * charges (BigQuery's US multi-region, Vertex AI's global endpoint) and names
 * the location in x_Location, and it writes PricingCategory lowercase. Read
 * as AWS is read, a GCP workspace filed half its spend under a blank Region
 * and showed 'standard' beside AWS's 'Standard'.
 *
 * Every GCP file here is the canonicalizer's output, as a sync leaves it: the
 * synthetic `gcp-main` provider (gcp-fixture.ts), the FOCUS 1.2 GCP sample, and
 * BigQuery-shaped rows for the edge cases.
 */

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

const SYNTHETIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'synthetic');
const FIXTURE_MONTHS = ['2026-01', '2026-02'];
const GCP_FIXTURE_PARQUET = `${SYNTHETIC_DIR}/${FIXTURE_GCP_PROVIDER_NAME}/raw/daily-*/*.parquet`;

const AWS_SPEC: ProviderSourceSpec = { name: asProviderName(FIXTURE_PROVIDER_NAME), type: 'aws', availablePeriods: FIXTURE_MONTHS };
const GCP_SPEC: ProviderSourceSpec = { name: asProviderName(FIXTURE_GCP_PROVIDER_NAME), type: 'gcp', availablePeriods: FIXTURE_MONTHS };

const REGION = asDimensionId('region');
const SERVICE = asDimensionId('service');
const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('provider'), label: 'Provider', field: 'provider' },
    { name: SERVICE, label: 'Service', field: 'service' },
    { name: REGION, label: 'Region', field: 'region' },
    { name: asDimensionId('pricing_category'), label: 'Pricing Category', field: 'pricing_category' },
  ],
  tags: [],
};
const costScope: CostScopeConfig = { costMetric: 'billed', rules: [] };

const JAN_FEB = { start: asDateString('2026-01-01'), end: asDateString('2026-02-28') };
const FEB = { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') };

let conn: Conn;
let ownedInstance: DuckDBInstance | null = null;
let tmpRoot: string;

async function rowsOf(sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  if (params.length === 0) return (await conn.run(sql)).getRowObjects();
  const stmt = await conn.prepare(sql);
  for (const [i, p] of params.entries()) {
    if (typeof p === 'number') stmt.bindDouble(i + 1, p);
    else stmt.bindVarchar(i + 1, String(p));
  }
  return (await stmt.run()).getRowObjects();
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return Number.NaN;
}

function opts(providers: readonly ProviderSourceSpec[], dataDir = SYNTHETIC_DIR): QueryContextOptions {
  return { dataDir, dimensions, providers, costScope };
}

/** Entity → total of a cost query (its rows repeat per top service). */
async function costByEntity(groupBy: typeof REGION, providers: readonly ProviderSourceSpec[], dateRange = JAN_FEB, dataDir = SYNTHETIC_DIR, filters = {}): Promise<Map<string, number>> {
  const q = buildCostQuery({ groupBy, dateRange, filters }, opts(providers, dataDir));
  const totals = new Map<string, number>();
  for (const r of await rowsOf(q.sql, q.params)) totals.set(String(r['entity']), num(r['total_cost']));
  return totals;
}

/** Billed cost of the raw GCP fixture rows of one service, per the export itself. */
async function rawServiceTotal(service: string, range = JAN_FEB): Promise<number> {
  const [row] = await rowsOf(`
    SELECT SUM(BilledCost) AS total FROM read_parquet('${GCP_FIXTURE_PARQUET}')
    WHERE ServiceName = '${service}'
      AND make_timestamp(epoch_us(ChargePeriodStart))::DATE BETWEEN DATE '${range.start}' AND DATE '${range.end}'`);
  return num(row?.['total']);
}

/** BigQuery's delivered shape for the columns these cases vary; the
 *  canonicalizer synthesizes the rest. */
interface BqRow {
  readonly service: string;
  readonly regionId: string | null;
  readonly location: string | null;
  readonly pricing: string | null;
  readonly billed: number;
}

function sqlText(v: string | null): string {
  return v === null ? 'CAST(NULL AS VARCHAR)' : `'${v}'`;
}

/** One GCP month put through the real canonicalizer into `{root}/{name}/raw/`.
 *  `withLocation: false` writes an export without the x_Location column. */
async function writeBqPeriod(root: string, name: string, rows: readonly BqRow[], withLocation = true): Promise<void> {
  const staging = join(root, `staging-${name}`);
  await mkdir(staging, { recursive: true });
  const values = rows.map(r => `(
    TIMESTAMPTZ '2026-03-10 12:00:00+00', 'proj-1', 'Project 1',
    CAST(${String(r.billed)} AS DECIMAL(38,9)), CAST(${String(r.billed)} AS DECIMAL(38,9)),
    '${r.service}', ${sqlText(r.regionId)}, ${sqlText(r.location)}, 'Usage', ${sqlText(r.pricing)}
  )`).join(',');
  const location = withLocation ? 'x_Location,' : '';
  await conn.run(`COPY (
    SELECT ChargePeriodStart, SubAccountId, SubAccountName, BilledCost, EffectiveCost,
      ServiceName, RegionId, ${location} ChargeCategory, PricingCategory
    FROM (VALUES ${values}) AS t(ChargePeriodStart, SubAccountId, SubAccountName, BilledCost, EffectiveCost,
      ServiceName, RegionId, x_Location, ChargeCategory, PricingCategory)
  ) TO '${join(staging, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);
  const out = join(root, name, 'raw', 'daily-2026-03');
  await mkdir(out, { recursive: true });
  await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: join(out, 'part-0.parquet'), connection: conn });
}

beforeAll(async () => {
  const instance = await DuckDBInstance.create();
  ownedInstance = instance;
  conn = await instance.connect();
  tmpRoot = await mkdtemp(join(tmpdir(), 'cg-gcp-region-'));
});

afterAll(async () => {
  conn.disconnectSync();
  ownedInstance?.closeSync();
  ownedInstance = null;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('GCP Region falls back to x_Location', () => {
  it('starts from an export that leaves RegionId empty on its multi-region and global rows', async () => {
    // The premise: without it the assertions below would pass on RegionId alone.
    const rows = await rowsOf(`
      SELECT ServiceName AS service, RegionId AS region_id, x_Location AS location
      FROM read_parquet('${GCP_FIXTURE_PARQUET}')
      WHERE COALESCE(RegionId, '') = '' GROUP BY ALL ORDER BY 1`);
    expect(rows).toEqual([
      { service: 'Cloud Storage', region_id: '', location: 'us' },
      { service: 'Networking', region_id: '', location: 'global' },
    ]);
  });

  it('groups those rows under their location in the cost query, leaving no blank Region', async () => {
    const totals = await costByEntity(REGION, [GCP_SPEC]);
    expect([...totals.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['europe-west1', 'global', 'us']);
    expect(totals.get('us')).toBeCloseTo(await rawServiceTotal('Cloud Storage'), 6);
    expect(totals.get('global')).toBeCloseTo(await rawServiceTotal('Networking'), 6);
  });

  it('files them the same way in the trend and daily queries', async () => {
    const trend = buildTrendQuery(
      { groupBy: REGION, dateRange: FEB, filters: {}, deltaThreshold: asDollars(0), percentThreshold: 0 },
      opts([GCP_SPEC]),
    );
    const current = new Map((await rowsOf(trend.sql, trend.params)).map(r => [String(r['entity']), num(r['current_cost'])]));
    expect(current.get('us')).toBeCloseTo(await rawServiceTotal('Cloud Storage', FEB), 6);
    expect(current.get('global')).toBeCloseTo(await rawServiceTotal('Networking', FEB), 6);
    expect(current.has('')).toBe(false);

    const daily = buildDailyCostsQuery({ groupBy: REGION, dateRange: FEB, filters: {} }, opts([GCP_SPEC]));
    const byGroup = new Map<string, number>();
    for (const r of await rowsOf(daily.sql, daily.params)) {
      const group = String(r['group_name']);
      byGroup.set(group, (byGroup.get(group) ?? 0) + num(r['cost']));
    }
    expect([...byGroup.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['europe-west1', 'global', 'us']);
    expect(byGroup.get('us')).toBeCloseTo(await rawServiceTotal('Cloud Storage', FEB), 6);
  });

  it('keeps a Region filter on the location to exactly its rows', async () => {
    const services = await costByEntity(SERVICE, [GCP_SPEC], JAN_FEB, SYNTHETIC_DIR, { [REGION]: ['us'] });
    expect([...services.keys()]).toEqual(['Cloud Storage']);
  });

  it('names the location of the FOCUS 1.2 sample rows that carry no region', async () => {
    // The sample's provider-wide rows (support, tax) have an empty RegionId and
    // x_Location 'global', as the export delivers them.
    const native = await writeSampleParquet(conn, 'gcp', join(tmpRoot, 'samples'), 'native');
    const dataDir = join(tmpRoot, 'sample-ws');
    const out = join(dataDir, 'gcp', 'raw', `daily-${SAMPLE_MONTH}`);
    await mkdir(out, { recursive: true });
    await canonicalizeGcpPeriod({ stagingDir: dirname(native.parquetPath), outputPath: join(out, 'part-0.parquet'), connection: conn });

    // BilledCost is DECIMAL as BigQuery exports it.
    const [regionless] = await rowsOf(`SELECT CAST(SUM(BilledCost) AS DOUBLE) AS total FROM read_parquet('${native.parquetPath}') WHERE COALESCE(RegionId, '') = ''`);
    const spec: ProviderSourceSpec = { name: asProviderName('gcp'), type: 'gcp', availablePeriods: [SAMPLE_MONTH] };
    const month = { start: asDateString(`${SAMPLE_MONTH}-01`), end: asDateString(`${SAMPLE_MONTH}-31`) };
    const totals = await costByEntity(REGION, [spec], month, dataDir);
    expect(num(regionless?.['total'])).toBeGreaterThan(0);
    expect(totals.get('global')).toBeCloseTo(num(regionless?.['total']), 6);
    expect(totals.has('')).toBe(false);
  });

  it('leaves blank a row with neither, as a Marketplace row has', async () => {
    const dataDir = join(tmpRoot, 'marketplace');
    await writeBqPeriod(dataDir, 'gcp', [
      { service: 'BigQuery', regionId: '', location: 'us', pricing: 'standard', billed: 1 },
      { service: 'Compute Engine', regionId: 'europe-west4', location: 'europe-west4-a', pricing: 'standard', billed: 2 },
      { service: 'Partner Platform', regionId: null, location: null, pricing: null, billed: 4 },
    ]);
    const spec: ProviderSourceSpec = { name: asProviderName('gcp'), type: 'gcp', availablePeriods: ['2026-03'] };
    const march = { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') };
    // A set RegionId wins over x_Location, which can name the zone.
    expect(Object.fromEntries(await costByEntity(REGION, [spec], march, dataDir))).toEqual({ 'europe-west4': 2, us: 1, '': 4 });
  });

  it('reads the location under the org-accounts join as well', async () => {
    // A tag with an account fallback joins org-account-tags.json, which
    // prefixes every raw column with `src.`: the union that guards x_Location
    // must be what `src` names.
    const dataDir = join(tmpRoot, 'org-join');
    await writeBqPeriod(dataDir, 'gcp', [
      { service: 'BigQuery', regionId: '', location: 'us', pricing: 'standard', billed: 1 },
      { service: 'Compute Engine', regionId: 'europe-west4', location: 'europe-west4-a', pricing: 'standard', billed: 2 },
    ]);
    const orgAccountsPath = join(dataDir, 'org-account-tags.json');
    await writeFile(orgAccountsPath, JSON.stringify([{ id: 'proj-1', tags: { team: 'data' }, ouPath: '/Root' }]));
    const withFallback: DimensionsConfig = { builtIn: dimensions.builtIn, tags: [{ tagName: 'team', label: 'Team', accountTagFallback: 'team' }] };
    const source = buildSource({
      dataDir, tier: 'daily', dimensions: withFallback, orgAccountsPath, costMetric: 'billed',
      providers: [{ name: asProviderName('gcp'), type: 'gcp', periods: ['2026-03'] }],
    });
    expect(source).toContain('src.x_Location');
    const rows = await rowsOf(`SELECT region, SUM(cost) AS c FROM ${source} GROUP BY 1 ORDER BY 1`);
    expect(rows.map(r => [r['region'], num(r['c'])])).toEqual([['europe-west4', 2], ['us', 1]]);
  });

  it('reads an export without x_Location, with Region from RegionId alone', async () => {
    // x_Location reaches the files only because the canonicalizer passes every
    // export column through. A column missing from every file of a glob is a
    // binder error, which would fail every query of the workspace.
    const dataDir = join(tmpRoot, 'no-location');
    await writeBqPeriod(dataDir, 'gcp', [
      { service: 'BigQuery', regionId: '', location: null, pricing: 'standard', billed: 1 },
      { service: 'Compute Engine', regionId: 'europe-west4', location: null, pricing: 'standard', billed: 2 },
    ], false);
    const [column] = await rowsOf(`SELECT COUNT(*) AS n FROM parquet_schema('${join(dataDir, 'gcp', 'raw', 'daily-2026-03', 'part-0.parquet')}') WHERE name = 'x_Location'`);
    expect(num(column?.['n'])).toBe(0);

    const spec: ProviderSourceSpec = { name: asProviderName('gcp'), type: 'gcp', availablePeriods: ['2026-03'] };
    const march = { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') };
    expect(Object.fromEntries(await costByEntity(REGION, [spec], march, dataDir))).toEqual({ 'europe-west4': 2, '': 1 });
  });
});

describe('GCP Pricing Category takes the FOCUS casing', () => {
  it('shows one value per category in a mixed workspace', async () => {
    const raw = await rowsOf(`SELECT DISTINCT PricingCategory AS p FROM read_parquet('${GCP_FIXTURE_PARQUET}')`);
    expect(raw.map(r => r['p'])).toContain('standard');

    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [
      { name: AWS_SPEC.name, type: 'aws', periods: FIXTURE_MONTHS },
      { name: GCP_SPEC.name, type: 'gcp', periods: FIXTURE_MONTHS },
    ] });
    const rows = await rowsOf(`SELECT DISTINCT provider, pricing_category FROM ${source} ORDER BY 1, 2`);
    expect(rows.map(r => [r['provider'], r['pricing_category']])).toEqual([
      [FIXTURE_PROVIDER_NAME, ''], [FIXTURE_PROVIDER_NAME, 'Committed'], [FIXTURE_PROVIDER_NAME, 'Standard'],
      [FIXTURE_GCP_PROVIDER_NAME, ''], [FIXTURE_GCP_PROVIDER_NAME, 'Committed'], [FIXTURE_GCP_PROVIDER_NAME, 'Standard'],
    ]);
  });

  it('reads any casing of a FOCUS value, and passes another value through', async () => {
    const dataDir = join(tmpRoot, 'pricing');
    await writeBqPeriod(dataDir, 'gcp', [
      { service: 'Compute Engine', regionId: 'us-east1', location: 'us-east1', pricing: 'COMMITTED', billed: 1 },
      { service: 'Compute Engine', regionId: 'us-east1', location: 'us-east1', pricing: 'dynamic', billed: 2 },
      { service: 'Compute Engine', regionId: 'us-east1', location: 'us-east1', pricing: 'Other', billed: 4 },
      { service: 'Compute Engine', regionId: 'us-east1', location: 'us-east1', pricing: 'promotional', billed: 8 },
      { service: 'Compute Engine', regionId: 'us-east1', location: 'us-east1', pricing: null, billed: 16 },
    ]);
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: [{ name: asProviderName('gcp'), type: 'gcp', periods: ['2026-03'] }] });
    const rows = await rowsOf(`SELECT pricing_category AS p, SUM(cost) AS c FROM ${source} GROUP BY 1 ORDER BY 2`);
    expect(rows.map(r => [r['p'], num(r['c'])])).toEqual([
      ['Committed', 1], ['Dynamic', 2], ['Other', 4], ['promotional', 8], ['', 16],
    ]);
  });
});

describe('AWS rows read as before', () => {
  it('builds the AWS branch without the GCP projection', () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [{ name: AWS_SPEC.name, type: 'aws', periods: FIXTURE_MONTHS }] });
    expect(source).toContain("COALESCE(RegionId, '') AS region");
    expect(source).toContain("COALESCE(PricingCategory, '') AS pricing_category");
    expect(source).not.toContain('x_Location');
    expect(source).not.toContain('UNION ALL BY NAME');
  });

  it('keeps every AWS row on its RegionId beside GCP rows, a blank one included', async () => {
    const expected = await rowsOf(`
      SELECT COALESCE(RegionId, '') AS region, SUM(BilledCost) AS total
      FROM read_parquet('${SYNTHETIC_DIR}/${FIXTURE_PROVIDER_NAME}/raw/daily-*/*.parquet', union_by_name=true)
      WHERE make_timestamp(epoch_us(ChargePeriodStart))::DATE BETWEEN DATE '2026-01-01' AND DATE '2026-02-28'
      GROUP BY 1 ORDER BY 1`);
    expect(expected.map(r => r['region'])).toContain('');

    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, costMetric: 'billed', providers: [
      { name: AWS_SPEC.name, type: 'aws', periods: FIXTURE_MONTHS },
      { name: GCP_SPEC.name, type: 'gcp', periods: FIXTURE_MONTHS },
    ] });
    const rows = await rowsOf(`
      SELECT region, SUM(cost) AS total FROM ${source}
      WHERE provider = '${FIXTURE_PROVIDER_NAME}' AND usage_date BETWEEN DATE '2026-01-01' AND DATE '2026-02-28'
      GROUP BY 1 ORDER BY 1`);
    expect(rows.map(r => r['region'])).toEqual(expected.map(r => r['region']));
    for (const [i, r] of rows.entries()) expect(num(r['total'])).toBeCloseTo(num(expected[i]?.['total']), 6);
  });
});
