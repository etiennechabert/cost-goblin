import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asProviderName } from '@costgoblin/core';
import type { RollupStatus } from '@costgoblin/core';
import type { RawRow } from '../main/duckdb-client.js';
import { RollupStore, type RollupShape } from '../main/rollup-store.js';

/** RollupStore bookkeeping without DuckDB: a fake build writes each partition
 *  file itself and a fake row count answers partitionMeta, so status
 *  reporting, stats, concurrency and the epoch guards against a concurrent
 *  invalidate() can be driven step by step. */

const provider = (): ReturnType<typeof asProviderName> => asProviderName('aws-main');
const SHAPE: RollupShape = { signature: 'SIG-A', grainDimensions: ['service'] };
const ETAGS = { '2026-01': { f1: 'h1' }, '2026-02': { f2: 'h2' }, '2026-03': { f3: 'h3' } };

/** buildSql's output names the file the fake build must produce. */
const buildSql = (period: string, outPath: string): string => `BUILD ${period} -> ${outPath}`;

function outPathOf(sql: string): string {
  const out = sql.split(' -> ')[1];
  if (out === undefined) throw new Error(`not a build statement: ${sql}`);
  return out;
}

/** Fake DuckDB: builds write a small file, row-count probes answer `rowCounts`
 *  by partition period. Either step can be held open with a gate. */
class FakeDuck {
  rowCounts: Readonly<Record<string, unknown>> = {};
  /** When set, every build fails with what this returns for its period. */
  buildError: ((period: string) => { readonly error: unknown }) | null = null;
  builds: string[] = [];
  inFlight = 0;
  peakInFlight = 0;
  holdBuild: Promise<void> | null = null;
  holdCount: Promise<void> | null = null;
  onBuildStart: (() => void) | null = null;
  onCountStart: (() => void) | null = null;

  readonly runBuild = async (sql: string): Promise<RawRow[]> => {
    const period = sql.split(' ')[1] ?? '';
    this.builds.push(period);
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      this.onBuildStart?.();
      if (this.holdBuild !== null) await this.holdBuild;
      if (this.buildError !== null) throw this.buildError(period).error;
      await writeFile(outPathOf(sql), `parquet for ${period}`);
      return [];
    } finally {
      this.inFlight -= 1;
    }
  };

  readonly runQuery = async (sql: string): Promise<RawRow[]> => {
    this.onCountStart?.();
    if (this.holdCount !== null) await this.holdCount;
    const period = /daily-(\d{4}-\d{2})/.exec(sql)?.[1] ?? '';
    return period in this.rowCounts ? [{ n: this.rowCounts[period] }] : [];
  };
}

/** A promise plus the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

const tmpDirs: string[] = [];
let dataDir = '';
let duck: FakeDuck;
let statuses: RollupStatus[];

function newStore(buildConcurrency?: number): RollupStore {
  const store = new RollupStore({
    dataDir,
    providerName: provider,
    runQuery: duck.runQuery,
    runBuild: duck.runBuild,
    ...(buildConcurrency === undefined ? {} : { buildConcurrency }),
  });
  store.onStatusChanged(s => { statuses.push(s); });
  return store;
}

const rollupDir = (): string => join(dataDir, 'aws-main', 'rollup');

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cg-rollup-life-'));
  tmpDirs.push(dataDir);
  duck = new FakeDuck();
  statuses = [];
});

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

describe('RollupStore status and stats', () => {
  it('reports idle and no stats before anything is built, then ready with exact totals', async () => {
    const store = newStore();
    expect(statuses).toEqual([{ state: 'idle' }]);
    expect(store.getStats()).toBeNull();
    expect(store.getBuiltSignature()).toBeNull();
    store.markSettled();
    expect(store.getStatus()).toEqual({ state: 'idle' });

    duck.rowCounts = { '2026-01': 5n, '2026-02': 7 };
    await store.maintainPeriods(['2026-01', '2026-02', '2026-03'], buildSql, ETAGS, SHAPE);

    const fileBytes = (await stat(join(rollupDir(), 'daily-2026-01', 'rollup.parquet'))).size;
    expect(store.getStats()).toEqual({ rows: 12, bytes: fileBytes * 3, months: 3 });
    expect(store.getBuiltSignature()).toBe('SIG-A');
    expect(store.getStatus()).toEqual({ state: 'ready', periods: 3 });
    store.markSettled();
    expect(statuses.at(-1)).toEqual({ state: 'ready', periods: 3 });
  });

  it('stops notifying a listener once it unsubscribes', async () => {
    const store = newStore();
    const seen: RollupStatus[] = [];
    const off = store.onStatusChanged(s => { seen.push(s); });
    off();

    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);

    expect(seen).toEqual([{ state: 'idle' }]);
    expect(statuses.at(-1)).toEqual({ state: 'ready', periods: 1 });
  });

  it('reads no stats once every built partition is deleted', async () => {
    const store = newStore();
    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);

    await store.deletePeriod('2026-01');

    expect(store.getStats()).toBeNull();
    expect(store.isReady()).toBe(false);
  });

  it('falls back to raw for a query that touches no period', async () => {
    const store = newStore();
    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);

    expect(store.resolveSource({ requiredPeriods: [], tier: 'daily', neededColumns: ['service'] })).toBeUndefined();
    expect(store.resolveSource({ requiredPeriods: ['2026-01'], tier: 'daily', neededColumns: ['service', 'line_items'] }))
      .toContain('daily-2026-01/rollup.parquet');
  });
});

describe('RollupStore failed builds', () => {
  it('names the most common failure and counts the other distinct errors', async () => {
    duck.buildError = (period) => ({ error: new Error(period === '2026-03' ? 'IO Error: disk full' : 'Binder Error: no column team') });
    const store = newStore();

    await store.maintainPeriods(['2026-01', '2026-02', '2026-03'], buildSql, ETAGS, SHAPE);

    expect(store.getStatus()).toEqual({
      state: 'failed',
      message: '3 of 3 rollup partitions failed to build',
      reason: 'Binder Error: no column team (+1 other error)',
      periods: 0,
    });
  });

  it('pluralises several other errors, and trims a very long reason', async () => {
    const long = `Parser Error: ${'x'.repeat(500)}`;
    duck.buildError = (period) => ({ error: new Error(period === '2026-01' ? long : `error for ${period}`) });
    const store = newStore();

    await store.maintainPeriods(['2026-01', '2026-02', '2026-03'], buildSql, ETAGS, SHAPE);

    const status = store.getStatus();
    if (status.state !== 'failed') throw new Error(`expected failed, got ${status.state}`);
    expect(status.reason.endsWith(' (+2 other errors)')).toBe(true);
    const [first] = status.reason.split(' (+');
    expect(first).toHaveLength(401);
    expect(first?.endsWith('…')).toBe(true);
  });

  it('reports a single failed partition, thrown as a non-Error, in the singular', async () => {
    duck.buildError = () => ({ error: 'out of memory' });
    const store = newStore();

    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);

    expect(store.getStatus()).toEqual({ state: 'failed', message: '1 of 1 rollup partition failed to build', reason: 'out of memory', periods: 0 });
  });

  it('counts a partition whose row count comes back empty as zero rows', async () => {
    const store = newStore();

    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);

    expect(store.getStats()?.rows).toBe(0);
    expect(store.getStatus()).toEqual({ state: 'ready', periods: 1 });
  });
});

describe('RollupStore build concurrency', () => {
  // Every build is held at a gate until the lanes have had their chance to
  // fill, so the peak counts the lanes the store opens rather than how three
  // unheld builds happened to interleave (a fast first build could finish
  // before the second lane started).
  async function peakLanes(store: RollupStore): Promise<number> {
    const held = gate();
    duck.holdBuild = held.promise;
    const run = store.maintainPeriods(['2026-01', '2026-02', '2026-03'], buildSql, ETAGS, SHAPE);
    await vi.waitFor(() => { expect(duck.inFlight).toBeGreaterThan(0); });
    // Lanes start together; a turn of the event loop lets any further one in.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    held.open();
    await run;
    return duck.peakInFlight;
  }

  it('rounds the configured concurrency and never goes below one lane', async () => {
    const wide = newStore();
    wide.setBuildConcurrency(2.4);
    expect(await peakLanes(wide)).toBe(2);

    duck = new FakeDuck();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-rollup-life-'));
    tmpDirs.push(dataDir);
    const narrow = newStore(4);
    narrow.setBuildConcurrency(0);
    expect(await peakLanes(narrow)).toBe(1);
  });
});

describe('RollupStore manifest on disk', () => {
  it('treats a missing, unparsable or non-object manifest as no manifest', async () => {
    await expect(newStore().loadAndValidate(SHAPE, ETAGS)).resolves.toMatchObject({ fullyInvalid: true });

    await mkdir(rollupDir(), { recursive: true });
    for (const contents of ['{"schemaVersion": ', '42', 'null', '["not", "a", "manifest"]']) {
      await writeFile(join(rollupDir(), 'manifest.json'), contents);
      const store = newStore();

      const result = await store.loadAndValidate(SHAPE, ETAGS);

      expect(result.fullyInvalid).toBe(true);
      expect(store.isReady()).toBe(false);
    }
  });

  it('skips a period already built from the same raw files, unless forced', async () => {
    const store = newStore();
    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);

    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);
    expect(duck.builds).toEqual(['2026-01']);
    expect(store.getStatus()).toEqual({ state: 'ready', periods: 1 });

    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE, { force: true });
    expect(duck.builds).toEqual(['2026-01', '2026-01']);

    // Changed raw files invalidate the stamp.
    await store.maintainPeriods(['2026-01'], buildSql, { '2026-01': { f1: 'h1-new' } }, SHAPE);
    expect(duck.builds).toHaveLength(3);
  });

  it('leaves the manifest alone when deleting a period it never built, or when there is none', async () => {
    const empty = newStore();
    await expect(empty.deletePeriod('2026-01')).resolves.toBeUndefined();
    expect(await exists(join(rollupDir(), 'manifest.json'))).toBe(false);

    const store = newStore();
    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);
    const before = await readFile(join(rollupDir(), 'manifest.json'), 'utf-8');

    await store.deletePeriod('2026-05');

    expect(await readFile(join(rollupDir(), 'manifest.json'), 'utf-8')).toBe(before);
    expect([...store.getValidPeriods()]).toEqual(['2026-01']);
  });

  it('rebuilds every period into a fresh manifest when the shape changes', async () => {
    const store = newStore();
    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);

    await store.maintainPeriods(['2026-01'], buildSql, ETAGS, { signature: 'SIG-B', grainDimensions: ['service', 'account_id'] });

    expect(duck.builds).toEqual(['2026-01', '2026-01']);
    expect(store.getBuiltSignature()).toBe('SIG-B');
    const manifest: unknown = JSON.parse(await readFile(join(rollupDir(), 'manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({ shapeSignature: 'SIG-B', grainDimensions: ['service', 'account_id'] });
  });
});

describe('RollupStore against a concurrent invalidate()', () => {
  it('discards a build that was in flight, and skips the periods it had not started', async () => {
    const held = gate();
    duck.holdBuild = held.promise;
    const store = newStore();
    const invalidations: Promise<void>[] = [];
    duck.onBuildStart = () => { if (invalidations.length === 0) invalidations.push(store.invalidate()); };

    const building = store.maintainPeriods(['2026-01', '2026-02'], buildSql, ETAGS, SHAPE);
    await new Promise(resolve => { setImmediate(resolve); });
    held.open();
    await building;
    await Promise.all(invalidations);
    expect(invalidations).toHaveLength(1);

    expect(duck.builds).toEqual(['2026-01']);
    expect(store.isReady()).toBe(false);
    expect(await exists(rollupDir())).toBe(false);
    // The newer invalidate owns the status: the stale build never reports ready.
    expect(store.getStatus()).toEqual({ state: 'computing', done: 0, total: 0, periods: [], active: [] });
  });

  it('does not commit a partition whose row count was still being read', async () => {
    const held = gate();
    duck.holdCount = held.promise;
    const store = newStore();
    const invalidations: Promise<void>[] = [];
    duck.onCountStart = () => { if (invalidations.length === 0) invalidations.push(store.invalidate()); };

    const building = store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);
    await new Promise(resolve => { setImmediate(resolve); });
    held.open();
    await building;
    await Promise.all(invalidations);
    expect(invalidations).toHaveLength(1);

    expect(store.getBuiltSignature()).toBeNull();
    expect(await exists(join(rollupDir(), 'manifest.json'))).toBe(false);
  });

  it('drops queued work for an older shape and a queued delete once invalidated', async () => {
    const held = gate();
    duck.holdBuild = held.promise;
    const store = newStore();

    const first = store.maintainPeriods(['2026-01'], buildSql, ETAGS, SHAPE);
    await vi.waitFor(() => { expect(duck.builds).toEqual(['2026-01']); });
    // Queued behind the in-flight build, then superseded before they run.
    const reshaped = store.maintainPeriods(['2026-02'], buildSql, ETAGS, { signature: 'SIG-B', grainDimensions: ['service'] });
    const deleting = store.deletePeriod('2026-01');
    const invalidated = store.invalidate();
    held.open();
    await Promise.all([first, reshaped, deleting, invalidated]);

    expect(duck.builds).toEqual(['2026-01']);
    expect(store.isReady()).toBe(false);
    expect(store.getBuiltSignature()).toBeNull();
  });
});
