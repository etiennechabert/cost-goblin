import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { buildRollupPartitionQuery, rollupGrainColumns, type DimensionsConfig, type CostScopeConfig, type RollupStatus, asDimensionId } from '@costgoblin/core';
import { RollupStore, type RollupShape } from '../main/rollup-store.js';
import type { RawRow } from '../main/duckdb-client.js';

async function fetchRows(conn: DuckDBConnection, sql: string): Promise<RawRow[]> {
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
}

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
    runQuery = (sql: string): Promise<RawRow[]> => fetchRows(conn, sql);
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

  it('builds multiple periods concurrently on fresh connections, committing every manifest entry', async () => {
    // Each build runs on its own connection; a gate that only trips once BOTH
    // builds have arrived proves they actually overlap (a sequential impl would
    // stall at the gate until the 2s safety valve, leaving peak in-flight at 1).
    let arrived = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    let trip!: () => void;
    const gate = new Promise<void>(r => { trip = r; });
    const safety = setTimeout(() => { trip(); }, 2000);
    const onFreshConn = async (sql: string): Promise<RawRow[]> => {
      const c: DuckDBConnection = await db.connect();
      try { return await fetchRows(c, sql); } finally { c.disconnectSync(); }
    };
    const runBuild = async (sql: string): Promise<RawRow[]> => {
      arrived += 1;
      if (arrived >= 2) { clearTimeout(safety); trip(); }
      await gate;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try { return await onFreshConn(sql); } finally { inFlight -= 1; }
    };
    const store = new RollupStore({ dataDir, runQuery: onFreshConn, runBuild, buildConcurrency: 2 });
    await store.maintainPeriods(['2026-01', '2026-02'], buildSql, etags, shape);
    clearTimeout(safety);

    expect(peakInFlight).toBe(2);
    expect([...store.getValidPeriods()].sort()).toEqual(['2026-01', '2026-02']);
    for (const period of ['2026-01', '2026-02']) {
      await expect(stat(join(dataDir, 'aws', 'rollup', `daily-${period}`, 'rollup.parquet'))).resolves.toBeDefined();
    }
    // A reloaded store sees both partitions as valid → every commit landed.
    const reloaded = new RollupStore({ dataDir, runQuery });
    const v = await reloaded.loadAndValidate(shape, etags);
    expect([...v.validPeriods].sort()).toEqual(['2026-01', '2026-02']);
    const dir = await readdir(join(dataDir, 'aws', 'rollup'));
    expect(dir.some(f => f.endsWith('.tmp'))).toBe(false);
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

  it('surfaces the underlying error as the failed status reason', async () => {
    const failDir = await mkdtemp(join(tmpdir(), 'cg-rollup-fail-'));
    let captured: RollupStatus | undefined;
    const runBuild = (): Promise<RawRow[]> => Promise.reject(new Error('Binder Error: column "service" not found'));
    const store = new RollupStore({ dataDir: failDir, runQuery, runBuild });
    store.onStatusChanged((s) => { captured = s; });
    await store.maintainPeriods(['2026-01', '2026-02'], buildSql, etags, shape);

    expect(captured?.state).toBe('failed');
    if (captured?.state === 'failed') {
      expect(captured.message).toBe('2 of 2 rollup partitions failed to build');
      // Both periods fail with the same cause → one distinct reason, no "+N".
      expect(captured.reason).toBe('Binder Error: column "service" not found');
    }
    await rm(failDir, { recursive: true, force: true });
  });

  it('invalidate() removes the on-disk rollup and resets state', async () => {
    const store = new RollupStore({ dataDir, runQuery });
    await store.maintainPeriods(['2026-01'], buildSql, etags, shape);
    await store.invalidate();
    expect(store.isReady()).toBe(false);
    await expect(stat(join(dataDir, 'aws', 'rollup'))).rejects.toThrow();
  });
});
