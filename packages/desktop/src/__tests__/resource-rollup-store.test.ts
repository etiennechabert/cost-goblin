import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  asDimensionId,
  asProviderName,
  buildResourceRowsQuery,
  buildResourceTopQuery,
  buildSource,
  computePartitionEtagHash,
  logger,
  QUERY_CANCELLED_MESSAGE,
  resourceRollupDimensionColumns,
  type CostScopeConfig,
  type DimensionsConfig,
} from '@costgoblin/core';
import { ResourceRollupStore, type ResourceBuildSql, type ResourceRollupShape } from '../main/resource-rollup-store.js';
import type { RawRow } from '../main/duckdb-client.js';
import { fetchRows } from './helpers/duckdb-rows.js';

// `rename` commits a manifest: wrapped so a test can act between a build's
// last check and its commit.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_RAW = join(HERE, '..', '..', '..', 'core', 'src', '__fixtures__', 'synthetic', 'aws-main', 'raw');
const PROVIDER = asProviderName('aws');
const MONTHS = ['2026-01', '2026-02'];
/** Pairs kept per month: far fewer than the ~1,500 a fixture month holds. */
const PAIRS = 30;

/** A pair made heavy in January and tiny in February: stored in February
 *  only because January ranks it. */
const SHIFTING = { resource: 'arn:test:shifting-resource', description: 'heavy in January, tiny in February' };

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab' }],
};
const costScope: CostScopeConfig = { costMetric: 'effective', rules: [] };
const shape: ResourceRollupShape = { signature: 'SIG-1', dimensionColumns: resourceRollupDimensionColumns(dimensions) };
const etags = { '2026-01': { f1: 'h1' }, '2026-02': { f2: 'h2' } };

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? Number.NaN);
}

describe('ResourceRollupStore', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let root: string;
  let runQuery: (sql: string) => Promise<RawRow[]>;
  const dirs: string[] = [];

  /** A data dir of its own per store, all reading the same raw tree. */
  async function newDataDir(): Promise<string> {
    const dir = await mkdtemp(join(root, 'data-'));
    dirs.push(dir);
    return dir;
  }

  const rawDir = (): string => join(root, 'raw-data');
  const opts = (period: string) => ({ dataDir: rawDir(), dimensions, providers: [{ name: PROVIDER, type: 'aws' as const, availablePeriods: [period] }], costScope });
  const sql: ResourceBuildSql = {
    top: (period, outPath, pairs) => buildResourceTopQuery(period, 'daily', outPath, opts(period), pairs),
    rows: (period, outPath, heavyPath) => buildResourceRowsQuery(period, 'daily', outPath, heavyPath, opts(period)),
  };
  const raw = (periods: readonly string[] = MONTHS): string =>
    buildSource({ dataDir: rawDir(), tier: 'daily', dimensions, providers: [{ name: PROVIDER, type: 'aws', periods }], costMetric: 'effective' });

  type Run = (sql: string) => Promise<RawRow[]>;
  function newStore(dataDir: string, deps: { pairsPerMonth?: number; runBuild?: Run; runQuery?: Run } = {}): ResourceRollupStore {
    return new ResourceRollupStore({
      dataDir,
      providerName: () => PROVIDER,
      runQuery: deps.runQuery ?? runQuery,
      pairsPerMonth: deps.pairsPerMonth ?? PAIRS,
      ...(deps.runBuild === undefined ? {} : { runBuild: deps.runBuild }),
    });
  }

  const rollupDir = (dataDir: string): string => join(dataDir, 'aws', 'resource-rollup');
  interface PartitionOnDisk { readonly tailBound: number; readonly complete: boolean; readonly rows: number }
  function isPartitionOnDisk(value: unknown): value is PartitionOnDisk {
    return typeof value === 'object' && value !== null
      && 'tailBound' in value && typeof value.tailBound === 'number'
      && 'complete' in value && typeof value.complete === 'boolean'
      && 'rows' in value && typeof value.rows === 'number';
  }
  async function manifestOf(dataDir: string): Promise<{ generation: number; partitions: Record<string, PartitionOnDisk> }> {
    const parsed: unknown = JSON.parse(await readFile(join(rollupDir(dataDir), 'manifest.json'), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || !('generation' in parsed) || typeof parsed.generation !== 'number'
      || !('partitions' in parsed) || typeof parsed.partitions !== 'object' || parsed.partitions === null) throw new Error('not a manifest');
    const partitions: Record<string, PartitionOnDisk> = {};
    for (const [period, meta] of Object.entries(parsed.partitions)) {
      if (!isPartitionOnDisk(meta)) throw new Error(`not a partition: ${period}`);
      partitions[period] = meta;
    }
    return { generation: parsed.generation, partitions };
  }

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    root = await mkdtemp(join(tmpdir(), 'cg-resource-store-'));
    runQuery = (statement: string): Promise<RawRow[]> => fetchRows(conn, statement);

    // The fixture months, plus the shifting pair: one $5,000 line in January,
    // two one-cent lines in February.
    const extra = (period: string, day: string, cost: number): string => `
      SELECT * REPLACE (
        TIMESTAMP '${period}-${day}' AS ChargePeriodStart, '${SHIFTING.resource}' AS ResourceId, '${SHIFTING.description}' AS ChargeDescription,
        ${String(cost)}::DOUBLE AS EffectiveCost, ${String(cost)}::DOUBLE AS BilledCost, ${String(cost * 2)}::DOUBLE AS ListCost, 3::DOUBLE AS ConsumedQuantity)
      FROM (SELECT * FROM read_parquet('${join(SYNTHETIC_RAW, `daily-${period}`, 'data.parquet')}')
            WHERE ChargeCategory = 'Usage' AND PricingCategory = 'Standard' ORDER BY ChargePeriodStart, ResourceId LIMIT 1)`;
    const lines: Record<string, readonly string[]> = {
      '2026-01': [extra('2026-01', '15', 5000)],
      '2026-02': [extra('2026-02', '03', 0.01), extra('2026-02', '20', 0.01)],
    };
    for (const period of MONTHS) {
      const dir = join(rawDir(), 'aws', 'raw', `daily-${period}`);
      await mkdir(dir, { recursive: true });
      await conn.run(`COPY (
        SELECT * FROM read_parquet('${join(SYNTHETIC_RAW, `daily-${period}`, 'data.parquet')}')
        UNION ALL ${(lines[period] ?? []).join(' UNION ALL ')}
      ) TO '${join(dir, 'data.parquet')}' (FORMAT PARQUET)`);
    }
  });
  afterAll(async () => {
    conn.closeSync();
    await rm(root, { recursive: true, force: true });
  });
  // restoreAllMocks leaves a vi.mock factory's vi.fn alone: reset the rename wrapper by hand.
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(rename).mockReset(); });

  it('builds every month as one generation and serves the range from it', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    expect(store.isReady()).toBe(false);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });

    expect(store.isReady()).toBe(true);
    expect([...store.getValidPeriods()].sort((a, b) => a.localeCompare(b))).toEqual(MONTHS);
    const files = await readdir(rollupDir(dataDir));
    expect(files).toEqual(expect.arrayContaining(['manifest.json', 'heavy-1.parquet', 'daily-2026-01', 'daily-2026-02']));
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
    expect(await readdir(join(rollupDir(dataDir), 'daily-2026-02'))).toEqual(expect.arrayContaining(['top.parquet', 'rows-1.parquet']));

    const manifest = await manifestOf(dataDir);
    expect(manifest.generation).toBe(1);
    const served = store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['resource_id', 'description', 'service', 'cost', 'list_cost', 'usage_amount', 'line_items'] });
    expect(served?.source).toContain('daily-2026-01/rows-1.parquet');
    expect(served?.source).toContain('daily-2026-02/rows-1.parquet');
    expect(served?.heavySource).toContain('heavy-1.parquet');
    expect(served?.complete).toBe(false);
    expect(served?.tailBound).toBeCloseTo(num(manifest.partitions['2026-01']?.tailBound) + num(manifest.partitions['2026-02']?.tailBound), 9);
    expect(served?.tailBound).toBeGreaterThan(0);
    // One month alone carries its own bound only.
    expect(store.resolveSource({ requiredPeriods: ['2026-02'], neededColumns: ['cost'] })?.tailBound).toBeCloseTo(num(manifest.partitions['2026-02']?.tailBound), 9);
  });

  it('stores a pair in every month it is in once any month ranks it', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    const served = store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] });
    if (served === undefined) throw new Error('expected the rollup to serve both months');

    // February alone would leave the pair out: two cents is far under its bound.
    const februaryTop = await runQuery(`SELECT 1 FROM read_parquet('${join(rollupDir(dataDir), 'daily-2026-02', 'top.parquet')}') WHERE resource_id = '${SHIFTING.resource}'`);
    expect(februaryTop).toHaveLength(0);
    const perMonth = await runQuery(`
      SELECT strftime(usage_date, '%Y-%m') AS month, CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(line_items) AS DOUBLE) AS line_items
      FROM ${served.source} WHERE resource_id = '${SHIFTING.resource}' GROUP BY 1 ORDER BY 1`);
    expect(perMonth.map(r => [r['month'], num(r['cost']), num(r['line_items'])])).toEqual([['2026-01', 5000, 1], ['2026-02', 0.02, 2]]);
  });

  it('holds every heavy pair whole, and bounds every other pair, in each month', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    const served = store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] });
    if (served === undefined) throw new Error('expected the rollup to serve both months');
    const manifest = await manifestOf(dataDir);

    // Whole: over an arbitrary window, each stored pair costs what raw says.
    const window = `usage_date BETWEEN '2026-01-10' AND '2026-02-19'`;
    const perPair = (source: string, lineItems: string): string => `
      SELECT resource_id, description, CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(list_cost) AS DOUBLE) AS list_cost,
             CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount, CAST(${lineItems} AS DOUBLE) AS line_items
      FROM ${source} WHERE ${window} GROUP BY resource_id, description ORDER BY resource_id, description`;
    const rolled = await runQuery(perPair(served.source, 'SUM(line_items)'));
    const expected = await runQuery(perPair(`(SELECT * FROM ${raw()} WHERE (resource_id, description) IN (SELECT resource_id, description FROM ${served.heavySource}))`, 'COUNT(*)'));
    expect(rolled.length).toBeGreaterThan(PAIRS);
    expect(rolled).toHaveLength(expected.length);
    rolled.forEach((r, i) => {
      const e = expected[i];
      expect([r['resource_id'], r['description']]).toEqual([e?.['resource_id'], e?.['description']]);
      for (const m of ['cost', 'list_cost', 'usage_amount']) expect(num(r[m])).toBeCloseTo(num(e?.[m]), 6);
      expect(num(r['line_items'])).toBe(num(e?.['line_items']));
    });

    // Bounded: no pair left out weighs more than its month's tail bound.
    for (const period of MONTHS) {
      const [worst] = await runQuery(`
        SELECT MAX(weight) AS worst FROM (
          SELECT SUM(ABS(cost)) AS weight FROM ${raw([period])}
          WHERE (resource_id, description) NOT IN (SELECT resource_id, description FROM ${served.heavySource})
          GROUP BY resource_id, description)`);
      expect(num(worst?.['worst'])).toBeLessThanOrEqual(num(manifest.partitions[period]?.tailBound));
    }
  });

  it('marks a month complete, with no tail bound, when it keeps every pair', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir, { pairsPerMonth: 100_000 });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    const served = store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] });
    expect(served?.complete).toBe(true);
    expect(served?.tailBound).toBe(0);
    const [total] = await runQuery(`SELECT CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(line_items) AS DOUBLE) AS n FROM ${served?.source ?? ''}`);
    const [expected] = await runQuery(`SELECT CAST(SUM(cost) AS DOUBLE) AS cost, CAST(COUNT(*) AS DOUBLE) AS n FROM ${raw()}`);
    expect(num(total?.['cost'])).toBeCloseTo(num(expected?.['cost']), 6);
    expect(num(total?.['n'])).toBe(num(expected?.['n']));
  });

  it('adds the provider back as a constant, and refuses a column it does not store', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    const served = store.resolveSource({ requiredPeriods: ['2026-01'], neededColumns: ['provider', 'resource_id'] });
    const providers = await runQuery(`SELECT DISTINCT provider FROM ${served?.source ?? ''}`);
    expect(providers.map(r => r['provider'])).toEqual(['aws']);

    expect(store.resolveSource({ requiredPeriods: ['2026-01'], neededColumns: ['operation'] })).toBeUndefined();
    expect(store.resolveSource({ requiredPeriods: [], neededColumns: ['cost'] })).toBeUndefined();
    expect(store.resolveSource({ requiredPeriods: ['2026-01', '2025-12'], neededColumns: ['cost'] })).toBeUndefined();
  });

  it('builds nothing when every month is already built from its current raw files', async () => {
    const dataDir = await newDataDir();
    const builds: string[] = [];
    const store = newStore(dataDir, { runBuild: (statement) => { builds.push(statement); return runQuery(statement); } });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(builds).toHaveLength(4);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(builds).toHaveLength(4);
    expect((await manifestOf(dataDir)).generation).toBe(1);

    // A restart reads the manifest and builds nothing either.
    const reopened = newStore(dataDir, { runBuild: (statement) => { builds.push(statement); return runQuery(statement); } });
    expect(reopened.isReady()).toBe(false);
    await reopened.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(builds).toHaveLength(4);
    expect([...reopened.getValidPeriods()].sort((a, b) => a.localeCompare(b))).toEqual(MONTHS);
    expect(reopened.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.source).toContain('rows-1.parquet');
  });

  it('starts over when the manifest was built for another shape or pair count', async () => {
    const dataDir = await newDataDir();
    await newStore(dataDir).maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    await newStore(dataDir).maintain({ periods: MONTHS, etagsByPeriod: { ...etags, '2026-02': { f2: 'h2-new' } }, shape, sql });
    expect((await manifestOf(dataDir)).generation).toBe(2);

    const reshaped = newStore(dataDir);
    await reshaped.maintain({ periods: MONTHS, etagsByPeriod: etags, shape: { ...shape, signature: 'SIG-2' }, sql });
    expect((await manifestOf(dataDir)).generation).toBe(1);
    expect(reshaped.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.source).toContain('rows-1.parquet');

    const resized = newStore(dataDir, { pairsPerMonth: PAIRS + 5 });
    await resized.maintain({ periods: MONTHS, etagsByPeriod: etags, shape: { ...shape, signature: 'SIG-2' }, sql });
    const [heavy] = await runQuery(`SELECT COUNT(*) AS n FROM ${resized.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.heavySource ?? ''}`);
    expect(num(heavy?.['n'])).toBeGreaterThan(PAIRS + 5);
  });

  it('re-ranks only the month that changed, extracts every month again, and keeps one old generation', async () => {
    const dataDir = await newDataDir();
    const builds: string[] = [];
    const store = newStore(dataDir, { runBuild: (statement) => { builds.push(statement); return runQuery(statement); } });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    builds.length = 0;

    const changed = { ...etags, '2026-02': { f2: 'h2-new' } };
    await store.maintain({ periods: MONTHS, etagsByPeriod: changed, shape, sql });
    const tops = builds.filter(s => s.includes('top.parquet') && s.includes('row_number()'));
    expect(tops).toHaveLength(1);
    expect(tops[0]).toContain('daily-2026-02');
    expect(builds.filter(s => s.includes('rows-2.parquet'))).toHaveLength(2);
    expect((await manifestOf(dataDir)).generation).toBe(2);
    expect(store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.source).toContain('rows-2.parquet');
    // A query planned against generation 1 still finds its files.
    expect(await readdir(join(rollupDir(dataDir), 'daily-2026-01'))).toEqual(expect.arrayContaining(['rows-1.parquet', 'rows-2.parquet']));

    await store.maintain({ periods: MONTHS, changed: ['2026-01'], etagsByPeriod: changed, shape, sql });
    const january = await readdir(join(rollupDir(dataDir), 'daily-2026-01'));
    expect(january).toEqual(expect.arrayContaining(['rows-2.parquet', 'rows-3.parquet']));
    expect(january).not.toContain('rows-1.parquet');
    expect(await readdir(rollupDir(dataDir))).not.toContain('heavy-1.parquet');
  });

  it('stops serving a changed month at once, and the rest once its build fails', async () => {
    const dataDir = await newDataDir();
    let failRows = false;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const store = newStore(dataDir, {
      runBuild: (statement) => (failRows && statement.includes('daily-2026-02/rows-') ? Promise.reject(new Error('disk full')) : runQuery(statement)),
    });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });

    failRows = true;
    await store.maintain({ periods: MONTHS, changed: ['2026-02'], etagsByPeriod: etags, shape, sql });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('extracting 2026-02 failed — disk full'));
    expect([...store.getValidPeriods()]).toEqual(['2026-01']);
    expect(store.resolveSource({ requiredPeriods: ['2026-01'], neededColumns: ['cost'] })?.source).toContain('rows-2.parquet');
    expect(store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })).toBeUndefined();

    // The next call builds the month that was left out.
    failRows = false;
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect([...store.getValidPeriods()].sort((a, b) => a.localeCompare(b))).toEqual(MONTHS);
  });

  it('runs a build again when a view cancelled it, and gives up on any other error', async () => {
    const dataDir = await newDataDir();
    let cancelNext = 2;
    const store = newStore(dataDir, {
      runBuild: (statement) => {
        if (cancelNext > 0) { cancelNext -= 1; return Promise.reject(new Error(QUERY_CANCELLED_MESSAGE)); }
        return runQuery(statement);
      },
    });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect([...store.getValidPeriods()].sort((a, b) => a.localeCompare(b))).toEqual(MONTHS);

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const failing = newStore(await newDataDir(), { runBuild: () => Promise.reject(new Error('Binder Error: no such column')) });
    await failing.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(failing.isReady()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ranking 2026-01 failed'));
  });

  it('stops serving the changed months, and builds nothing, while the etags cannot be read', async () => {
    const dataDir = await newDataDir();
    const builds: string[] = [];
    const store = newStore(dataDir, { runBuild: (statement) => { builds.push(statement); return runQuery(statement); } });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    builds.length = 0;
    await store.maintain({ periods: MONTHS, changed: ['2026-02'], etagsByPeriod: null, shape, sql });
    expect(builds).toHaveLength(0);
    expect([...store.getValidPeriods()]).toEqual(['2026-01']);
  });

  it('drops a deleted month, on disk and in the manifest', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    await store.deletePeriod('2026-01');
    expect([...store.getValidPeriods()]).toEqual(['2026-02']);
    expect(await readdir(rollupDir(dataDir))).not.toContain('daily-2026-01');
    expect(Object.keys((await manifestOf(dataDir)).partitions)).toEqual(['2026-02']);
    // February still holds the shifting pair January made heavy, whole.
    const served = store.resolveSource({ requiredPeriods: ['2026-02'], neededColumns: ['cost'] });
    const [shifting] = await runQuery(`SELECT CAST(SUM(cost) AS DOUBLE) AS cost FROM ${served?.source ?? ''} WHERE resource_id = '${SHIFTING.resource}'`);
    expect(num(shifting?.['cost'])).toBeCloseTo(0.02, 9);

    // Without a loaded manifest the entry on disk still goes.
    const unloaded = newStore(dataDir);
    await unloaded.deletePeriod('2026-02');
    expect(Object.keys((await manifestOf(dataDir)).partitions)).toEqual([]);
  });

  it('removes the tree on invalidate, and a build queued before it writes nothing', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });

    const queued = store.maintain({ periods: MONTHS, changed: MONTHS, etagsByPeriod: etags, shape, sql });
    const dropped = store.invalidate();
    expect(store.isReady()).toBe(false);
    expect(store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })).toBeUndefined();
    await Promise.all([queued, dropped, store.whenIdle()]);
    await expect(readdir(rollupDir(dataDir))).rejects.toThrow(/ENOENT/);
    expect(store.isReady()).toBe(false);
  });

  it('reads a manifest that is not one as no manifest, and survives no provider on invalidate', async () => {
    const dataDir = await newDataDir();
    await mkdir(rollupDir(dataDir), { recursive: true });
    for (const contents of ['not json', '[]', '{"schemaVersion":1}', '{"schemaVersion":1,"shapeSignature":"SIG-1","pairsPerMonth":30,"generation":7,"dimensionColumns":"x","partitions":{}}']) {
      await writeFile(join(rollupDir(dataDir), 'manifest.json'), contents);
      const store = newStore(dataDir);
      await store.maintain({ periods: ['2026-01'], etagsByPeriod: etags, shape, sql });
      // Built from scratch, not on top of generation 7.
      expect((await manifestOf(dataDir)).generation).toBe(1);
    }

    // A partition entry without a numeric bound bounds nothing; one that is not an entry is dropped.
    await writeFile(join(rollupDir(dataDir), 'manifest.json'), JSON.stringify({
      schemaVersion: 1, shapeSignature: 'SIG-1', pairsPerMonth: PAIRS, generation: 4, dimensionColumns: ['usage_date'],
      partitions: { '2026-01': { rawEtagHash: computePartitionEtagHash(etags['2026-01']), tailBound: null, complete: false, rows: 1, bytes: 1 }, '2026-02': 'nope' },
    }));
    const store = newStore(dataDir);
    await store.maintain({ periods: ['2026-01'], etagsByPeriod: etags, shape, sql });
    expect([...store.getValidPeriods()]).toEqual(['2026-01']);
    expect(store.resolveSource({ requiredPeriods: ['2026-01'], neededColumns: ['usage_date'] })?.tailBound).toBe(Number.POSITIVE_INFINITY);

    const orphan = new ResourceRollupStore({ dataDir, providerName: () => { throw new Error('No provider configured'); }, runQuery });
    await expect(orphan.invalidate()).resolves.toBeUndefined();
  });

  it('stops serving a month marked stale until it is built again', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    store.markStale(['2026-02']);
    expect(store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })).toBeUndefined();
    expect(store.resolveSource({ requiredPeriods: ['2026-01'], neededColumns: ['cost'] })).toBeDefined();
    await store.maintain({ periods: MONTHS, changed: ['2026-02'], etagsByPeriod: etags, shape, sql });
    expect(store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.source).toContain('rows-2.parquet');
  });

  it('keeps a month marked stale during a build out of what that build serves', async () => {
    const dataDir = await newDataDir();
    // The sync finishes while February's rows are being extracted: the build
    // read files that were being replaced.
    let store: ResourceRollupStore | null = null;
    let marked = false;
    const building = newStore(dataDir, {
      runBuild: async (statement) => {
        const rows = await runQuery(statement);
        if (!marked && statement.includes('daily-2026-02/rows-')) { marked = true; store?.markStale(['2026-02']); }
        return rows;
      },
    });
    store = building;
    await building.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(marked).toBe(true);
    expect([...building.getValidPeriods()]).toEqual(['2026-01']);
    expect(building.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })).toBeUndefined();

    // Any later build takes the month up again, named or not.
    await building.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect([...building.getValidPeriods()].sort((a, b) => a.localeCompare(b))).toEqual(MONTHS);
    expect(building.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.source).toContain('rows-2.parquet');
  });

  it("runs the build's small queries again too when a view cancelled them", async () => {
    const dataDir = await newDataDir();
    // One cancel each for the heavy set, a tail read and a row count.
    const cancelOnce = new Set(['heavy-1.parquet', 'tail_bound', 'COUNT(*)::BIGINT AS n FROM']);
    const store = newStore(dataDir, {
      runQuery: (statement) => {
        const hit = [...cancelOnce].find(marker => statement.includes(marker));
        if (hit !== undefined) { cancelOnce.delete(hit); return Promise.reject(new Error(QUERY_CANCELLED_MESSAGE)); }
        return runQuery(statement);
      },
    });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(cancelOnce.size).toBe(0);
    expect([...store.getValidPeriods()].sort((a, b) => a.localeCompare(b))).toEqual(MONTHS);
  });

  it('builds nothing for a request worked out before the rollup was dropped', async () => {
    const dataDir = await newDataDir();
    const builds: string[] = [];
    const store = newStore(dataDir, { runBuild: (statement) => { builds.push(statement); return runQuery(statement); } });
    const epoch = store.currentEpoch();
    await store.invalidate();
    // `shape` and `sql` may describe the cost scope the drop was for.
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql, epoch });
    expect(builds).toEqual([]);
    expect(store.isReady()).toBe(false);

    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql, epoch: store.currentEpoch() });
    expect(store.isReady()).toBe(true);
  });

  it('does not serve a generation dropped while its manifest was being written', async () => {
    const dataDir = await newDataDir();
    const store = newStore(dataDir);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let dropped: Promise<void> | undefined;
    // The drop lands after the build's last check, as the manifest is renamed into place.
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      dropped = store.invalidate();
      await actual.rename(from, to);
    });
    await store.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(dropped).toBeDefined();
    await dropped;
    expect(store.isReady()).toBe(false);
    expect(store.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })).toBeUndefined();
    await expect(readdir(rollupDir(dataDir))).rejects.toThrow(/ENOENT/);
  });

  it('stops building once dropped, and never names a generation twice', async () => {
    const dataDir = await newDataDir();
    const builds: string[] = [];
    let store: ResourceRollupStore | null = null;
    let dropOnFirstBuild = false;
    const building = newStore(dataDir, {
      runBuild: async (statement) => {
        builds.push(statement);
        const rows = await runQuery(statement);
        if (dropOnFirstBuild) { dropOnFirstBuild = false; void store?.invalidate(); }
        return rows;
      },
    });
    store = building;
    await building.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    expect(building.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.source).toContain('rows-1.parquet');

    // Dropped while the first of two months is ranked: the second is never read.
    builds.length = 0;
    dropOnFirstBuild = true;
    await building.maintain({ periods: MONTHS, changed: MONTHS, etagsByPeriod: etags, shape, sql });
    await building.whenIdle();
    expect(builds).toHaveLength(1);
    expect(building.isReady()).toBe(false);

    // The rebuild after the drop is not generation 1 again: a query over it
    // must not read like one over the rollup that was dropped.
    await building.maintain({ periods: MONTHS, etagsByPeriod: etags, shape, sql });
    const served = building.resolveSource({ requiredPeriods: MONTHS, neededColumns: ['cost'] })?.source ?? '';
    expect(served).not.toContain('rows-1.parquet');
    expect(served).not.toContain('rows-2.parquet');
    expect(served).toContain('rows-3.parquet');
  });
});
