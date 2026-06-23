import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { buildSource, buildRollupPartitionQuery } from '../query/builder.js';
import { rollupGrainColumns } from '../rollup/grain.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDimensionId } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
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
  return buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, periods: [PERIOD], costMetric: 'unblended' });
}

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
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, availablePeriods: [PERIOD], costScope: scope([]) }));
    const desc = await queryAll(conn, `DESCRIBE SELECT * FROM ${glob}`);
    const cols = desc.map(r => String(r['column_name'])).sort((a, b) => a.localeCompare(b));
    const expected = [...rollupGrainColumns(dimensions), 'cost', 'line_items'].sort((a, b) => a.localeCompare(b));
    expect(cols).toEqual(expected);
    // usage_type is disabled → must NOT be in the partition
    expect(cols).not.toContain('usage_type');
    expect(cols).not.toContain('resource_id');
  });

  it('pre-aggregation is lossless: rollup SUM(cost) == raw SUM(cost) for the month, overall and per-service', async () => {
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, availablePeriods: [PERIOD], costScope: scope([]) }));

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

  it('drops exclusion rows at build time', async () => {
    const rawWhere = `WHERE usage_date >= '${PERIOD}-01' AND usage_date < '2026-02-01'`;
    const top = (await queryAll(conn, `SELECT service, CAST(SUM(cost) AS DOUBLE) c FROM ${rawSourceJan()} ${rawWhere} GROUP BY service ORDER BY c DESC LIMIT 1`))[0];
    const excludedService = String(top?.['service']);
    const excludedCost = Number(top?.['c']);
    const rawTotal = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawSourceJan()} ${rawWhere}`))[0]?.['t']);

    const rule = { id: 'x', name: 'exclude top service', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('service'), values: [excludedService] }] };
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, availablePeriods: [PERIOD], costScope: scope([rule]) }));

    const rollTotal = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${glob}`))[0]?.['t']);
    expect(rollTotal).toBeCloseTo(rawTotal - excludedCost, 2);
    const stillThere = await queryAll(conn, `SELECT 1 FROM ${glob} WHERE service = '${excludedService.replaceAll("'", "''")}' LIMIT 1`);
    expect(stillThere.length).toBe(0);
  });
});
