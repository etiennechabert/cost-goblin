import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { buildRollupPartitionQuery, rollupGrainColumns, type DimensionsConfig, type CostScopeConfig, asDimensionId } from '@costgoblin/core';
import { RollupStore, type RollupShape } from '../main/rollup-store.js';
import type { RawRow } from '../main/duckdb-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// core synthetic fixtures live under packages/core/src/__fixtures__/synthetic
const SYNTHETIC_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__', 'synthetic');

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab' }],
};
const costScope: CostScopeConfig = { costMetric: 'unblended', costPerspective: 'gross', rules: [] };
const shape: RollupShape = { signature: 'SIG-1', grainDimensions: rollupGrainColumns(dimensions), availableColumns: ['account_id', 'service'] };
const etags = { '2026-01': { 'f1': 'h1' }, '2026-02': { 'f2': 'h2' } };

describe('RollupStore', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let dataDir: string;
  let runQuery: (sql: string) => Promise<RawRow[]>;

  const buildSql = (period: string, outPath: string) =>
    buildRollupPartitionQuery(period, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions, availablePeriods: [period], costScope });

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-rollup-store-'));
    runQuery = async (sql: string): Promise<RawRow[]> => {
      const result = await conn.run(sql);
      const cols = result.columnCount;
      const names: string[] = [];
      for (let i = 0; i < cols; i++) names.push(result.columnName(i));
      const rows: RawRow[] = [];
      let chunk = await result.fetchChunk();
      while (chunk !== null && chunk.rowCount > 0) {
        for (let r = 0; r < chunk.rowCount; r++) {
          const row: Record<string, unknown> = {};
          for (let c = 0; c < cols; c++) { const n = names[c]; if (n !== undefined) row[n] = chunk.getColumnVector(c).getItem(r); }
          rows.push(row);
        }
        chunk = await result.fetchChunk();
      }
      return rows;
    };
  });
  afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('builds a partition, writes an atomic manifest (no .tmp), and routes to it', async () => {
    const store = new RollupStore({ dataDir, runQuery });
    await store.maintainPeriods(['2026-01'], buildSql, etags, shape);

    expect(store.isReady()).toBe(true);
    expect([...store.getValidPeriods()]).toEqual(['2026-01']);
    await expect(stat(join(dataDir, 'aws', 'rollup', 'daily-2026-01', 'rollup.parquet'))).resolves.toBeDefined();
    const dir = await readdir(join(dataDir, 'aws', 'rollup'));
    expect(dir).toContain('manifest.json');
    expect(dir.some(f => f.endsWith('.tmp'))).toBe(false);

    const src = store.resolveSource({ requiredPeriods: ['2026-01'], tier: 'daily', neededColumns: ['service', 'cost'] });
    expect(src).toContain('read_parquet');
    // Reads only the requested month's partition, never a daily-* wildcard.
    expect(src).toContain('daily-2026-01/rollup.parquet');
    expect(src).not.toContain('daily-*');
  });

  it('resolveSource falls back to raw (undefined) on hour bounds, out-of-grain column, or an unbuilt period', async () => {
    const store = new RollupStore({ dataDir, runQuery });
    await store.maintainPeriods(['2026-01'], buildSql, etags, shape);
    expect(store.resolveSource({ requiredPeriods: ['2026-01'], tier: 'hourly', neededColumns: ['service'] })).toBeUndefined();
    expect(store.resolveSource({ requiredPeriods: ['2026-01'], tier: 'daily', neededColumns: ['resource_id'] })).toBeUndefined();
    expect(store.resolveSource({ requiredPeriods: ['2026-01', '2026-02'], tier: 'daily', neededColumns: ['service'] })).toBeUndefined();
  });

  it('warm-load validates a persisted manifest: matching reuses, changed etag is stale, new signature is fully invalid', async () => {
    const builder = new RollupStore({ dataDir, runQuery });
    await builder.maintainPeriods(['2026-01'], buildSql, etags, shape);

    const fresh = new RollupStore({ dataDir, runQuery });
    const ok = await fresh.loadAndValidate(shape, etags);
    expect(ok.fullyInvalid).toBe(false);
    expect([...ok.validPeriods]).toEqual(['2026-01']);
    expect(fresh.resolveSource({ requiredPeriods: ['2026-01'], tier: 'daily', neededColumns: ['service'] })).toContain('read_parquet');

    const staleStore = new RollupStore({ dataDir, runQuery });
    const stale = await staleStore.loadAndValidate(shape, { ...etags, '2026-01': { 'f1': 'h1-CHANGED' } });
    expect([...stale.stalePeriods]).toEqual(['2026-01']);
    expect(stale.validPeriods.size).toBe(0);

    const sigStore = new RollupStore({ dataDir, runQuery });
    const bad = await sigStore.loadAndValidate({ ...shape, signature: 'SIG-2' }, etags);
    expect(bad.fullyInvalid).toBe(true);
    expect(sigStore.resolveSource({ requiredPeriods: ['2026-01'], tier: 'daily', neededColumns: ['service'] })).toBeUndefined();
  });

  it('deletePeriod removes the partition and its manifest entry', async () => {
    const store = new RollupStore({ dataDir, runQuery });
    await store.maintainPeriods(['2026-01'], buildSql, etags, shape);
    await store.deletePeriod('2026-01');
    expect([...store.getValidPeriods()]).toEqual([]);
    await expect(stat(join(dataDir, 'aws', 'rollup', 'daily-2026-01'))).rejects.toThrow();
    const reloaded = new RollupStore({ dataDir, runQuery });
    const v = await reloaded.loadAndValidate(shape, etags);
    expect(v.validPeriods.size).toBe(0);
  });

  it('invalidate() removes the on-disk rollup and resets state', async () => {
    const store = new RollupStore({ dataDir, runQuery });
    await store.maintainPeriods(['2026-01'], buildSql, etags, shape);
    await store.invalidate();
    expect(store.isReady()).toBe(false);
    await expect(stat(join(dataDir, 'aws', 'rollup'))).rejects.toThrow();
  });
});
