import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { buildSource, buildRollupPartitionQuery } from '../query/builder.js';
import { rollupGrainColumns, rollupGrainDimensions } from '../rollup/grain.js';
import { FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDimensionId, asProviderName } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const PROVIDER = asProviderName(FIXTURE_PROVIDER_NAME);
const PERIOD = '2026-01';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
    { name: asDimensionId('usage_type'), label: 'Usage Type', field: 'usage_type', enabled: false },
  ],
  tags: [
    { tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab' },
    { tagName: 'environment', label: 'Environment', concept: 'environment', normalize: 'lowercase' },
  ],
};

interface Row { [k: string]: unknown }

async function queryAll(conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string): Promise<Row[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: Row[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Row = {};
      for (let c = 0; c < cols; c++) {
        const name = names[c];
        if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
      }
      rows.push(row);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

function scope(rules: CostScopeConfig['rules']): CostScopeConfig {
  return { costMetric: 'unblended', costPerspective: 'gross', rules };
}

function rawSourceJan(): string {
  return buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [{ name: PROVIDER, periods: [PERIOD] }], costMetric: 'unblended' });
}

describe('rollupGrainDimensions', () => {
  it('groups a built-in display column under its dimension and drops disabled dims', () => {
    const dims = rollupGrainDimensions(dimensions);
    // account_name rides with account_id — it is NOT a standalone dimension.
    expect(dims.find(d => d.column === 'account_id')?.columns).toEqual(['account_id', 'account_name']);
    expect(dims.some(d => d.column === 'account_name')).toBe(false);
    // disabled usage_type is absent; single-column dims carry just themselves.
    expect(dims.some(d => d.column === 'usage_type')).toBe(false);
    expect(dims.find(d => d.column === 'service')?.columns).toEqual(['service']);
    expect(dims.find(d => d.column === 'tag_team')?.columns).toEqual(['tag_team']);
    // Built-ins first, then tags; one entry per enabled dimension.
    expect(dims.map(d => d.column)).toEqual(['account_id', 'service', 'region', 'tag_team', 'tag_environment']);
  });

  it('skips the provider built-in — injected at read time, never stored in the grain', () => {
    const withProvider: DimensionsConfig = {
      ...dimensions,
      builtIn: [{ name: asDimensionId('provider'), label: 'Provider', field: 'provider' }, ...dimensions.builtIn],
    };
    // Even enabled, `field === 'provider'` must not enter the stored grain:
    // the column is a per-branch constant injected by buildSource at read time.
    expect(rollupGrainColumns(withProvider)).toEqual(rollupGrainColumns(dimensions));
    expect(rollupGrainColumns(withProvider)).not.toContain('provider');
    expect(rollupGrainDimensions(withProvider)).toEqual(rollupGrainDimensions(dimensions));
    expect(rollupGrainDimensions(withProvider).some(d => d.column === 'provider')).toBe(false);
  });

  it('collapses derived dimensions that share one physical column to a single entry', () => {
    // Region / Country / Continent are query-time views of the same `region`
    // column — they must not produce duplicate, identically-attributed rows.
    const shared: DimensionsConfig = {
      builtIn: [
        { name: asDimensionId('region'), label: 'Region', field: 'region' },
        { name: asDimensionId('region_country'), label: 'Country', field: 'region' },
        { name: asDimensionId('region_continent'), label: 'Continent', field: 'region' },
        { name: asDimensionId('service'), label: 'Service', field: 'service' },
      ],
      tags: [],
    };
    const dims = rollupGrainDimensions(shared);
    expect(dims.map(d => d.column)).toEqual(['region', 'service']);
  });
});

describe('buildRollupPartitionQuery', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  const outPath = join(tmpdir(), `cg-rollup-test-${String(process.pid)}-${PERIOD}.parquet`);
  const glob = `read_parquet('${outPath.replaceAll('\\', '/')}')`;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });
  afterAll(async () => { await rm(outPath, { force: true }); });

  it('writes a partition whose columns are exactly the grain + cost + line_items', async () => {
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, availablePeriods: [PERIOD] }], costScope: scope([]) }));
    const desc = await queryAll(conn, `DESCRIBE SELECT * FROM ${glob}`);
    const cols = desc.map(r => String(r['column_name'])).sort((a, b) => a.localeCompare(b));
    const expected = [...rollupGrainColumns(dimensions), 'cost', 'line_items'].sort((a, b) => a.localeCompare(b));
    expect(cols).toEqual(expected);
    // usage_type is disabled → must NOT be in the partition
    expect(cols).not.toContain('usage_type');
    expect(cols).not.toContain('resource_id');
  });

  it('pre-aggregation is lossless: rollup SUM(cost) == raw SUM(cost) for the month, overall and per-service', async () => {
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, availablePeriods: [PERIOD] }], costScope: scope([]) }));

    const rawWhere = `WHERE usage_date >= '${PERIOD}-01' AND usage_date < '2026-02-01'`;
    const rawTotal = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawSourceJan()} ${rawWhere}`))[0]?.['t']);
    const rollTotal = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${glob}`))[0]?.['t']);
    expect(rollTotal).toBeGreaterThan(0);
    expect(rollTotal).toBeCloseTo(rawTotal, 2);

    const rawByService = new Map<string, number>();
    for (const r of await queryAll(conn, `SELECT service, CAST(SUM(cost) AS DOUBLE) c FROM ${rawSourceJan()} ${rawWhere} GROUP BY service`)) {
      rawByService.set(String(r['service']), Number(r['c']));
    }
    for (const r of await queryAll(conn, `SELECT service, CAST(SUM(cost) AS DOUBLE) c FROM ${glob} GROUP BY service`)) {
      expect(Number(r['c'])).toBeCloseTo(rawByService.get(String(r['service'])) ?? -1, 2);
    }
  });

  it('SUM(line_items) equals the raw line-item count — backs the Table overview total_rows on the rollup', async () => {
    // The Table widget's overview routes through the rollup (SUM(cost) /
    // SUM(line_items) per usage_date). For total_rows to match the raw path's
    // COUNT(*), the per-grain line_items must sum back to the raw row count.
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, availablePeriods: [PERIOD] }], costScope: scope([]) }));
    const rawWhere = `WHERE usage_date >= '${PERIOD}-01' AND usage_date < '2026-02-01'`;
    const rawCount = Number((await queryAll(conn, `SELECT CAST(COUNT(*) AS BIGINT) n FROM ${rawSourceJan()} ${rawWhere}`))[0]?.['n']);
    const rollCount = Number((await queryAll(conn, `SELECT CAST(SUM(line_items) AS BIGINT) n FROM ${glob}`))[0]?.['n']);
    expect(rollCount).toBeGreaterThan(0);
    expect(rollCount).toBe(rawCount);
  });

  it('drops exclusion rows at build time', async () => {
    const rawWhere = `WHERE usage_date >= '${PERIOD}-01' AND usage_date < '2026-02-01'`;
    const top = (await queryAll(conn, `SELECT service, CAST(SUM(cost) AS DOUBLE) c FROM ${rawSourceJan()} ${rawWhere} GROUP BY service ORDER BY c DESC LIMIT 1`))[0];
    const excludedService = String(top?.['service']);
    const excludedCost = Number(top?.['c']);
    const rawTotal = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawSourceJan()} ${rawWhere}`))[0]?.['t']);

    const rule = { id: 'x', name: 'exclude top service', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('service'), values: [excludedService] }] };
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, availablePeriods: [PERIOD] }], costScope: scope([rule]) }));

    const rollTotal = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${glob}`))[0]?.['t']);
    expect(rollTotal).toBeCloseTo(rawTotal - excludedCost, 2);
    const stillThere = await queryAll(conn, `SELECT 1 FROM ${glob} WHERE service = '${excludedService.replaceAll("'", "''")}' LIMIT 1`);
    expect(stillThere).toHaveLength(0);
  });
});
