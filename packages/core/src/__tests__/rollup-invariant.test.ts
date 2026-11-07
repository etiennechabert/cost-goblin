import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { buildSource, buildRollupPartitionQuery } from '../query/builder.js';
import { FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDimensionId, asProviderName } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const PROVIDER = asProviderName(FIXTURE_PROVIDER_NAME);
const MONTHS = ['2026-01', '2026-02'];

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab' }],
};
const costScope: CostScopeConfig = { costMetric: 'effective', rules: [] };

interface Row { [k: string]: unknown }
async function queryAll(conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string): Promise<Row[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount; const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: Row[] = []; let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) { const row: Row = {}; for (let c = 0; c < cols; c++) { const n = names[c]; if (n !== undefined) row[n] = chunk.getColumnVector(c).getItem(r); } rows.push(row); }
    chunk = await result.fetchChunk();
  }
  return rows;
}

// The rollup invariant: aggregating the multi-month partition GLOB (with a
// date-range filter, as the dashboard handlers do) yields exactly the same
// numbers as aggregating raw over the same window+scope. This is what
// resolveSource relies on when it routes a dashboard query to the rollup.
describe('rollup multi-month glob == raw over the window', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let rollupDir: string;
  let glob: string;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    rollupDir = await mkdtemp(join(tmpdir(), 'cg-rollup-inv-'));
    for (const m of MONTHS) {
      const dir = join(rollupDir, `daily-${m}`);
      await mkdir(dir, { recursive: true });
      await conn.run(buildRollupPartitionQuery(m, 'daily', join(dir, 'rollup.parquet'), { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: [m] }], costScope }));
    }
    glob = `read_parquet('${join(rollupDir, 'daily-*', 'rollup.parquet').replaceAll('\\', '/')}')`;
  });
  afterAll(async () => { await rm(rollupDir, { recursive: true, force: true }); });

  const window = `usage_date >= '2026-01-01' AND usage_date < '2026-03-01'`;
  const rawSrc = () => buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [{ name: PROVIDER, type: 'aws', periods: MONTHS }], costMetric: 'effective' });

  it('total matches across the 2-month window', async () => {
    const raw = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawSrc()} WHERE ${window}`))[0]?.['t']);
    const roll = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${glob} WHERE ${window}`))[0]?.['t']);
    expect(roll).toBeGreaterThan(0);
    expect(roll).toBeCloseTo(raw, 2);
  });

  it('per-service and per-account aggregations match (the shapes handlers issue)', async () => {
    for (const dim of ['service', 'account_id']) {
      const rawMap = new Map<string, number>();
      for (const r of await queryAll(conn, `SELECT ${dim} k, CAST(SUM(cost) AS DOUBLE) c FROM ${rawSrc()} WHERE ${window} GROUP BY ${dim}`)) rawMap.set(String(r['k']), Number(r['c']));
      const rollRows = await queryAll(conn, `SELECT ${dim} k, CAST(SUM(cost) AS DOUBLE) c FROM ${glob} WHERE ${window} GROUP BY ${dim}`);
      expect(rollRows).toHaveLength(rawMap.size);
      for (const r of rollRows) expect(Number(r['c'])).toBeCloseTo(rawMap.get(String(r['k'])) ?? -1, 2);
    }
  });

  it('a sub-window only reads the months it touches (date pushdown over the glob)', async () => {
    const subWin = `usage_date >= '2026-02-01' AND usage_date < '2026-03-01'`;
    const raw = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawSrc()} WHERE ${subWin}`))[0]?.['t']);
    const roll = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${glob} WHERE ${subWin}`))[0]?.['t']);
    expect(roll).toBeCloseTo(raw, 2);
  });
});

// Description is off by default, so a rollup rarely stores it, but the build
// must still be able to read it: for the grain once the user turns it on, and
// for an exclusion rule on it either way. A build that can't read it fails on
// every month, and the dashboards with it.
describe('rollup partitions reading Description', () => {
  const MONTH = '2026-01';
  const JANUARY = `usage_date >= '2026-01-01' AND usage_date < '2026-02-01'`;
  const DESCRIPTION = { name: asDimensionId('description'), label: 'Description', field: 'description' };
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let rollupDir: string;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    rollupDir = await mkdtemp(join(tmpdir(), 'cg-rollup-description-'));
  });
  afterAll(async () => { await rm(rollupDir, { recursive: true, force: true }); });

  async function buildPartition(name: string, dims: DimensionsConfig, scope: CostScopeConfig): Promise<string> {
    const out = join(rollupDir, `${name}.parquet`);
    await conn.run(buildRollupPartitionQuery(MONTH, 'daily', out, { dataDir: SYNTHETIC_DIR, dimensions: dims, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: [MONTH] }], costScope: scope }));
    return `read_parquet('${out.replaceAll('\\', '/')}')`;
  }
  const rawJanuary = (dims: DimensionsConfig): string => buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions: dims, providers: [{ name: PROVIDER, type: 'aws', periods: [MONTH] }], costMetric: 'effective' });

  it('stores it when the dimension is on, with raw\'s total for each description', async () => {
    const on: DimensionsConfig = { ...dimensions, builtIn: [...dimensions.builtIn, DESCRIPTION] };
    const rollup = await buildPartition('on', on, costScope);

    const raw = await queryAll(conn, `SELECT description k, CAST(SUM(cost) AS DOUBLE) c FROM ${rawJanuary(on)} WHERE ${JANUARY} GROUP BY 1`);
    const rolled = await queryAll(conn, `SELECT description k, CAST(SUM(cost) AS DOUBLE) c FROM ${rollup} GROUP BY 1`);
    expect(raw.length).toBeGreaterThan(1);
    expect(rolled).toHaveLength(raw.length);
    const rawByDescription = new Map(raw.map(r => [String(r['k']), Number(r['c'])]));
    for (const r of rolled) expect(Number(r['c'])).toBeCloseTo(rawByDescription.get(String(r['k'])) ?? -1, 2);
  });

  it('applies an exclusion rule on it when the dimension is off, without storing it', async () => {
    const off: DimensionsConfig = { ...dimensions, builtIn: [...dimensions.builtIn, { ...DESCRIPTION, enabled: false }] };
    const top = String((await queryAll(conn, `SELECT description k FROM ${rawJanuary(off)} WHERE ${JANUARY} GROUP BY 1 ORDER BY SUM(cost) DESC LIMIT 1`))[0]?.['k']);
    const rule = { id: 'no-top', name: 'No top description', enabled: true, builtIn: false, conditions: [{ dimensionId: DESCRIPTION.name, values: [top] }] };
    const rollup = await buildPartition('off', off, { ...costScope, rules: [rule] });

    const kept = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawJanuary(off)} WHERE ${JANUARY} AND description <> '${top.replaceAll("'", "''")}'`))[0]?.['t']);
    const rolled = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rollup}`))[0]?.['t']);
    expect(kept).toBeGreaterThan(0);
    expect(rolled).toBeCloseTo(kept, 2);
    const columns = await queryAll(conn, `DESCRIBE SELECT * FROM ${rollup}`);
    expect(columns.map(c => c['column_name'])).not.toContain('description');
  });

  it('reads no column the partition does not need', async () => {
    const rollup = buildRollupPartitionQuery(MONTH, 'daily', join(rollupDir, 'plan.parquet'), { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: [MONTH] }], costScope });
    const select = rollup.slice(rollup.indexOf('(') + 1, rollup.lastIndexOf(') TO '));
    const plan = (await queryAll(conn, `EXPLAIN ${select}`)).map(r => String(r['explain_value'])).join('\n');
    // Not slim any more, so nothing but DuckDB's pruning keeps a rebuild from
    // scanning these strings across every line item of the month.
    expect(plan).toContain('ServiceName');
    expect(plan).not.toContain('ChargeDescription');
    expect(plan).not.toContain('ConsumedQuantity');
  });
});
