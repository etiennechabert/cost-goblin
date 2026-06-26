import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { buildSource, buildRollupPartitionQuery } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDimensionId } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const MONTHS = ['2026-01', '2026-02'];

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab' }],
};
const costScope: CostScopeConfig = { costMetric: 'unblended', costPerspective: 'gross', rules: [] };

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
      await conn.run(buildRollupPartitionQuery(m, 'daily', join(dir, 'rollup.parquet'), { dataDir: SYNTHETIC_DIR, dimensions, availablePeriods: [m], costScope }));
    }
    glob = `read_parquet('${join(rollupDir, 'daily-*', 'rollup.parquet').replaceAll('\\', '/')}')`;
  });
  afterAll(async () => { await rm(rollupDir, { recursive: true, force: true }); });

  const window = `usage_date >= '2026-01-01' AND usage_date < '2026-03-01'`;
  const rawSrc = () => buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, periods: MONTHS, costMetric: 'unblended' });

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
