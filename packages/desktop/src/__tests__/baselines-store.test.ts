import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { asDimensionId, asDollars, asProviderName, asTagValue } from '@costgoblin/core';
import type {
  BaselineRecomputeStatus,
  BaselineRecord,
  BaselineScope,
  BaselineSpec,
  BaselinesDiscoveryConfig,
  CostScopeConfig,
  DimensionId,
  DimensionsConfig,
  TagValue,
} from '@costgoblin/core';
import { BaselineStore, type BaselineEngineDeps } from '../main/baselines-store.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__', 'synthetic');
// Literal mirror of FIXTURE_PROVIDER_NAME in packages/core/src/__fixtures__/layout.ts
// (not importable here — outside this package's tsconfig rootDir).
const FIXTURE_PROVIDER = asProviderName('aws-main');
// Independent verification SQL reads the same parquet directly, bypassing the builders.
const GLOB = `read_parquet('${SYNTHETIC_DIR}/aws-main/raw/daily-*/*.parquet', union_by_name=true)`;

// The fixture data spans 2026-01-01..2026-02-28. Discovery windows are anchored
// on todayUtc(), so the suite fakes Date (and only Date — timers stay real for
// DuckDB's async I/O) to a fixed day shortly after the fixture range.
const NOW_ISO = '2026-03-04T12:00:00.000Z';
const TODAY = '2026-03-04';
// end = today - default lagDays(2); trailing drift window = end - 29.
const QUERY_END = '2026-03-02';
const TRAILING_START = '2026-02-01';

const EC2 = 'Amazon Elastic Compute Cloud';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    // High-cardinality on the fixture (~2.8k distinct over ~3k rows): the
    // cardinality probe must drop it from the auto discovery grain — which only
    // happens if the store coerces DuckDB's bigint COUNT columns (num() guard).
    { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' },
  ],
  tags: [],
};
const costScope: CostScopeConfig = { costMetric: 'billed', rules: [] };

const DISCOVERY_CONFIG: BaselinesDiscoveryConfig = {
  lookbackDays: 365,
  windowDays: 30,
  lowerPct: 10,
  upperPct: 90,
  minMonthlyCost: asDollars(100),
  minSavings: asDollars(0),
  reopenPct: 15,
  grainDimensions: [],
};
// Discovery classifies a tuple as auto-ignored when total / lookbackMonths < minMonthlyCost.
const IGNORE_THRESHOLD = 100 * (365 / 30);

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  throw new Error(`expected numeric cell, got ${typeof v}`);
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  throw new Error(`expected string cell, got ${typeof v}`);
}

function rec(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('expected a JSON object');
  return { ...v };
}

function svcScope(service: string): BaselineScope {
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  filters[asDimensionId('service')] = [asTagValue(service)];
  return { kind: 'filter', filters };
}

function filterKeys(scope: BaselineScope): readonly string[] {
  return scope.kind === 'filter' ? Object.keys(scope.filters).sort() : [];
}

function filterValues(scope: BaselineScope, dim: string): readonly string[] {
  if (scope.kind !== 'filter') return [];
  const vals = scope.filters[asDimensionId(dim)];
  return vals === undefined ? [] : vals.map(String);
}

/** Reloaded specs re-validate their basis, which re-seeds built-in exclusion
 *  rules and the default marketplace attribution — drop the basis when
 *  comparing records across a persistence round-trip. */
function withoutBasis(r: BaselineRecord): Omit<BaselineRecord, 'spec'> & { spec: Omit<BaselineSpec, 'basis'> } {
  const { basis: dropped, ...spec } = r.spec;
  void dropped;
  return { ...r, spec };
}

describe('BaselineStore', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  const tmpDirs: string[] = [];

  const newStateDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'cg-baselines-'));
    tmpDirs.push(d);
    return d;
  };

  const sql = (q: string): ReturnType<typeof fetchRows> => fetchRows(conn, q);

  const makeDeps = (stateDir: string): BaselineEngineDeps => ({
    dataDir: SYNTHETIC_DIR,
    stateDir,
    getFirstProviderName: () => Promise.resolve(FIXTURE_PROVIDER),
    getQueryProviders: () => Promise.resolve([{ name: FIXTURE_PROVIDER, availablePeriods: ['2026-01', '2026-02'] }]),
    getQueryDimensions: () => Promise.resolve(dimensions),
    getCostScope: () => Promise.resolve(costScope),
    getAccountMap: () => Promise.resolve(new Map<string, string>()),
    getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
    getOrgTreeConfig: () => Promise.resolve({ tree: [] }),
    runPreparedQuery: (q, params) => fetchRowsPrepared(conn, q, params),
    rollupStore: { getBuiltSignature: () => null, resolveSource: () => undefined },
  });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW_ISO) });
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  describe('config', () => {
    let stateDir: string;
    let store: BaselineStore;
    let deps: BaselineEngineDeps;

    beforeAll(async () => {
      stateDir = await newStateDir();
      store = new BaselineStore(stateDir);
      deps = makeDeps(stateDir);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('defaults read COSTGOBLIN_BASELINES_* env overrides; invalid values fall back', () => {
      vi.stubEnv('COSTGOBLIN_BASELINES_WINDOW_DAYS', '7');
      vi.stubEnv('COSTGOBLIN_BASELINES_MIN_MONTHLY_COST', '250');
      vi.stubEnv('COSTGOBLIN_BASELINES_LOOKBACK_DAYS', 'not-a-number');
      const state = store.getConfigState();
      expect(state.isCustom).toBe(false);
      expect(state.config.windowDays).toBe(7);
      expect(state.config.minMonthlyCost).toBe(250);
      expect(state.config.lookbackDays).toBe(365);
      expect(state.config.lowerPct).toBe(10);
      expect(state.config.upperPct).toBe(90);
      expect(state.config.reopenPct).toBe(15);
      expect(state.config.minSavings).toBe(0);
      expect(state.config.grainDimensions).toEqual([]);
    });

    it('setConfig overrides env, persists across a reload; resetConfig restores env-driven defaults', async () => {
      vi.stubEnv('COSTGOBLIN_BASELINES_WINDOW_DAYS', '3');
      const custom: BaselinesDiscoveryConfig = { ...DISCOVERY_CONFIG, windowDays: 14 };
      const set = await store.setConfig(custom);
      expect(set).toEqual({ config: custom, isCustom: true });

      const reloaded = new BaselineStore(stateDir);
      await reloaded.load(deps);
      expect(reloaded.getConfigState()).toEqual({ config: custom, isCustom: true });

      const reset = await store.resetConfig();
      expect(reset.isCustom).toBe(false);
      expect(reset.config.windowDays).toBe(3);
    });
  });

  describe('discovery', () => {
    let store: BaselineStore;
    let deps: BaselineEngineDeps;
    let expectedTuples: number;
    let expectedServices: number;
    let topAccount: string;
    let pinnedId: string;

    beforeAll(async () => {
      vi.setSystemTime(new Date(NOW_ISO));
      const stateDir = await newStateDir();
      store = new BaselineStore(stateDir);
      deps = makeDeps(stateDir);
      await store.setConfig(DISCOVERY_CONFIG);
      const [tuples] = await sql(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT SubAccountId, COALESCE(ServiceName, '') FROM ${GLOB})`);
      expectedTuples = num(tuples?.['n']);
      const [services] = await sql(`SELECT COUNT(DISTINCT COALESCE(ServiceName, '')) AS n FROM ${GLOB}`);
      expectedServices = num(services?.['n']);
      const [top] = await sql(`SELECT SubAccountId AS a FROM ${GLOB} WHERE ServiceName = '${EC2}' GROUP BY 1 ORDER BY SUM(BilledCost) DESC LIMIT 1`);
      topAccount = str(top?.['a']);
    });

    it('runs discovery over the fixtures, reporting status transitions to idle with lastRun', async () => {
      const statuses: BaselineRecomputeStatus[] = [];
      const unsub = store.onStatusChanged((s) => { statuses.push(s); });
      await store.recompute(deps);
      unsub();

      expect(statuses[0]).toEqual({ state: 'idle', lastRun: null });
      expect(statuses.some((s) => s.state === 'running' && s.phase === 'discovering')).toBe(true);
      expect(statuses.some((s) => s.state === 'running' && s.phase === 'computing')).toBe(true);
      expect(statuses[statuses.length - 1]).toEqual({ state: 'idle', lastRun: NOW_ISO });
      expect(store.getStatus()).toEqual({ state: 'idle', lastRun: NOW_ISO });
    });

    it('enumerates every (account, service) tuple; high-cardinality resource_id is dropped from the grain (bigint num() guard)', async () => {
      const res = await store.list(deps, {});
      expect(res.total).toBe(expectedTuples);
      expect(res.counts.all).toBe(expectedTuples);
      for (const r of res.items) {
        expect(r.spec.source).toBe('discovered');
        // If num() failed to coerce the probe's bigint counts, every cardinality
        // would read 0 and resource_id would survive into the grain.
        expect(filterKeys(r.spec.scope)).toEqual(['account_id', 'service']);
      }
    });

    it('auto-ignores tuples below minMonthlyCost; tracked tuples get history-derived stats', async () => {
      const [cnt] = await sql(
        `SELECT SUM(CASE WHEN total < ${String(IGNORE_THRESHOLD)} THEN 1 ELSE 0 END) AS ignored
         FROM (SELECT SUM(BilledCost) AS total FROM ${GLOB} GROUP BY SubAccountId, COALESCE(ServiceName, ''))`,
      );
      const expectedIgnored = num(cnt?.['ignored']);
      const res = await store.list(deps, {});
      expect(res.counts.ignored).toBe(expectedIgnored);
      expect(res.counts['new']).toBe(expectedTuples - expectedIgnored);
      expect(res.counts.open).toBe(res.counts['new']);
      for (const r of res.items) {
        if (r.triageStatus === 'ignored') {
          expect(r.stats).toBeNull();
          expect(r.status).toBe('insufficient-data');
        } else {
          expect(r.stats).not.toBeNull();
          expect(r.currentDaily).toBeGreaterThan(0);
        }
      }
    });

    it('stores per-day history matching a direct SQL aggregation, plus a same-day snapshot', async () => {
      const res = await store.list(deps, {});
      const item = res.items.find(
        (r) => filterValues(r.spec.scope, 'account_id')[0] === topAccount && filterValues(r.spec.scope, 'service')[0] === EC2,
      );
      expect(item).toBeDefined();
      if (item === undefined) return;

      const detail = await store.getDetail(deps, item.spec.id);
      expect(detail).not.toBeNull();
      if (detail === null) return;

      const expectedDaily = await sql(
        `SELECT ChargePeriodStart::DATE::VARCHAR AS d, SUM(BilledCost) AS c FROM ${GLOB}
         WHERE ServiceName = '${EC2}' AND SubAccountId = '${topAccount}' GROUP BY 1 ORDER BY 1`,
      );
      expect(detail.dailyHistory.length).toBe(expectedDaily.length);
      detail.dailyHistory.forEach((p, i) => {
        expect(String(p.date)).toBe(str(expectedDaily[i]?.['d']));
        expect(p.cost).toBeCloseTo(num(expectedDaily[i]?.['c']), 6);
      });

      expect(detail.windowDays).toBe(30);
      expect(detail.record.stats?.dataPoints).toBe(expectedDaily.length);
      expect(detail.record.bestAchieved).not.toBeNull();
      expect(detail.snapshots.length).toBe(1);
      const snap = detail.snapshots[0];
      expect(String(snap?.date)).toBe(TODAY);
      expect(snap?.status).toBe(detail.record.status);
      expect(snap?.current).toBeCloseTo(detail.record.currentDaily, 6);
      expect(snap?.lower).toBeCloseTo(detail.record.effectiveLower, 6);
      expect(snap?.upper).toBeCloseTo(detail.record.effectiveUpper, 6);
    });

    it('list filters by triage, sorts, pages, and sums the discovered partition', async () => {
      const all = await store.list(deps, {});
      const open = await store.list(deps, { triage: 'open' });
      expect(open.total).toBe(all.counts.open);
      expect(open.items.every((r) => ['new', 'tracking', 'acting'].includes(r.triageStatus))).toBe(true);
      const ignoredOnly = await store.list(deps, { triage: 'ignored' });
      expect(ignoredOnly.total).toBe(all.counts.ignored);

      const byCurrentAsc = await store.list(deps, { sortBy: 'current', sortDir: 'asc' });
      for (let i = 1; i < byCurrentAsc.items.length; i++) {
        expect(byCurrentAsc.items[i]?.currentDaily ?? 0).toBeGreaterThanOrEqual(byCurrentAsc.items[i - 1]?.currentDaily ?? 0);
      }

      const page = await store.list(deps, { offset: 3, limit: 5 });
      expect(page.items).toEqual(all.items.slice(3, 8));
      expect(page.total).toBe(all.total);

      const expectedPotential = all.items.reduce((s, r) => s + r.savings.potentialMonthly, 0);
      expect(all.totalPotentialMonthly).toBeCloseTo(expectedPotential, 6);
    });

    it('coalesces concurrent recompute calls (single discovery pass)', async () => {
      const seen: BaselineRecomputeStatus[] = [];
      const unsub = store.onStatusChanged((s) => { seen.push(s); });
      await Promise.all([store.recompute(deps), store.recompute(deps)]);
      unsub();
      expect(seen.filter((s) => s.state === 'running' && s.phase === 'discovering').length).toBe(1);
    });

    it('re-discovery upserts by scope (stable ids) and never overrides user-set triage with auto-ignore', async () => {
      const before = await store.list(deps, {});
      const target = before.items.find(
        (r) => filterValues(r.spec.scope, 'account_id')[0] === topAccount && filterValues(r.spec.scope, 'service')[0] === EC2,
      );
      const other = before.items.find((r) => r.triageStatus === 'new' && r.spec.id !== target?.spec.id);
      expect(target).toBeDefined();
      expect(other).toBeDefined();
      if (target === undefined || other === undefined) return;
      pinnedId = target.spec.id;

      await store.update(deps, pinnedId, { triageStatus: 'tracking' });
      await store.setConfig({ ...DISCOVERY_CONFIG, minMonthlyCost: asDollars(1_000_000) });
      await store.recompute(deps);

      const squeezed = await store.list(deps, {});
      expect(squeezed.total).toBe(before.total);
      expect(squeezed.items.find((r) => r.spec.id === pinnedId)?.triageStatus).toBe('tracking');
      expect(squeezed.items.find((r) => r.spec.id === other.spec.id)?.triageStatus).toBe('ignored');

      await store.setConfig(DISCOVERY_CONFIG);
      await store.recompute(deps);
      const restored = await store.list(deps, {});
      expect(restored.items.find((r) => r.spec.id === other.spec.id)?.triageStatus).toBe('new');
      expect(restored.items.find((r) => r.spec.id === pinnedId)?.triageStatus).toBe('tracking');
    });

    it('a grain change prunes untouched baselines but keeps user-edited ones with blanked history', async () => {
      await store.setConfig({ ...DISCOVERY_CONFIG, grainDimensions: [asDimensionId('service')] });
      await store.recompute(deps);

      const res = await store.list(deps, {});
      expect(res.total).toBe(expectedServices + 1);
      const kept = res.items.find((r) => r.spec.id === pinnedId);
      expect(kept?.triageStatus).toBe('tracking');
      expect(kept?.stats).toBeNull();
      expect(kept?.status).toBe('insufficient-data');
      for (const r of res.items) {
        if (r.spec.id === pinnedId) continue;
        expect(filterKeys(r.spec.scope)).toEqual(['service']);
      }
    });

    it('startFresh wipes even user-edited discovered baselines and re-mints fresh ids', async () => {
      await store.recompute(deps, { startFresh: true });
      const res = await store.list(deps, {});
      expect(res.total).toBe(expectedServices);
      expect(res.items.some((r) => r.spec.id === pinnedId)).toBe(false);
      expect(res.counts.tracking).toBe(0);
    });
  });

  describe('recompute failure', () => {
    it('surfaces the error, preserves the last successful run, and stops notifying unsubscribed listeners', async () => {
      vi.setSystemTime(new Date(NOW_ISO));
      const stateDir = await newStateDir();
      const st = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);
      await st.setConfig({ ...DISCOVERY_CONFIG, grainDimensions: [asDimensionId('service')] });
      await st.recompute(deps);
      expect(st.getStatus()).toEqual({ state: 'idle', lastRun: NOW_ISO });

      const seen: BaselineRecomputeStatus[] = [];
      const unsub = st.onStatusChanged((s) => { seen.push(s); });
      unsub();

      const failing: BaselineEngineDeps = { ...deps, runPreparedQuery: () => Promise.reject(new Error('duckdb exploded')) };
      await st.recompute(failing);
      expect(st.getStatus()).toEqual({ state: 'error', message: 'duckdb exploded', lastRun: NOW_ISO });
      // Only the immediate replay on subscribe — nothing after unsubscribing.
      expect(seen).toEqual([{ state: 'idle', lastRun: NOW_ISO }]);
    });
  });

  describe('manual lifecycle', () => {
    let stateDir: string;
    let store: BaselineStore;
    let deps: BaselineEngineDeps;
    let ec2Id: string;

    beforeAll(async () => {
      vi.setSystemTime(new Date(NOW_ISO));
      stateDir = await newStateDir();
      store = new BaselineStore(stateDir);
      deps = makeDeps(stateDir);
      await store.setConfig(DISCOVERY_CONFIG);
    });

    it('create recomputes immediately and returns the derived record', async () => {
      const created = await store.create(deps, { scope: svcScope(EC2), name: 'EC2 spend' });
      ec2Id = created.spec.id;
      expect(created.spec.source).toBe('manual');
      expect(created.spec.name).toBe('EC2 spend');
      expect(created.spec.createdAt).toBe(NOW_ISO);
      expect(created.scopeLabel).toBe(EC2);
      expect(created.triageStatus).toBe('new');
      expect(created.stats).not.toBeNull();

      const [expected] = await sql(
        `SELECT SUM(BilledCost) AS total, COUNT(DISTINCT ChargePeriodStart::DATE) AS n_days FROM ${GLOB} WHERE ServiceName = '${EC2}'`,
      );
      const detail = await store.getDetail(deps, ec2Id);
      expect(detail?.dailyHistory.length).toBe(num(expected?.['n_days']));
      const total = (detail?.dailyHistory ?? []).reduce((s, p) => s + p.cost, 0);
      expect(total).toBeCloseTo(num(expected?.['total']), 4);
      expect(detail?.snapshots.length).toBe(1);
    });

    it('rejects a duplicate scope', async () => {
      await expect(store.create(deps, { scope: svcScope(EC2) })).rejects.toThrow('A baseline for this scope already exists.');
    });

    it('a scope matching no rows derives insufficient-data with zero savings and no snapshot', async () => {
      const created = await store.create(deps, { scope: svcScope('No Such Service') });
      expect(created.stats).toBeNull();
      expect(created.current).toBeNull();
      expect(created.status).toBe('insufficient-data');
      expect(created.savings).toEqual({ potentialDaily: 0, realizedDaily: 0, potentialMonthly: 0, realizedMonthly: 0 });
      expect(await store.getSnapshots(deps, created.spec.id)).toEqual([]);
    });

    it('manual band updates drive deriveStatus transitions and log band-change notes', async () => {
      const over = await store.update(deps, ec2Id, { manualBand: { mode: 'absolute', lower: 0.02, upper: 0.05 } });
      expect(over?.status).toBe('over');
      expect(over?.effectiveUpper).toBe(0.05);

      const under = await store.update(deps, ec2Id, { manualBand: { mode: 'absolute', lower: 100_000, upper: 200_000 } });
      expect(under?.status).toBe('under');

      const inBand = await store.update(deps, ec2Id, { manualBand: { mode: 'absolute', lower: 1, upper: 100_000 } });
      expect(inBand?.status).toBe('in-band');

      const cleared = await store.update(deps, ec2Id, { manualBand: null });
      expect(cleared?.spec.manualBand).toBeUndefined();
      expect(cleared?.effectiveLower).toBe(cleared?.stats?.bands.lower);
      expect(cleared?.effectiveUpper).toBe(cleared?.stats?.bands.upper);

      expect(cleared?.triage.notes.length).toBe(4);
      expect(cleared?.triage.notes[0]?.text).toContain('band');
    });

    it('triage updates append a status-change note with the ticket', async () => {
      const updated = await store.update(deps, ec2Id, { triageStatus: 'acting', note: { text: 'ticket opened', ticket: 'COST-42' } });
      expect(updated?.triageStatus).toBe('acting');
      const notes = updated?.triage.notes ?? [];
      const note = notes[notes.length - 1];
      expect(note?.text).toContain('status new → acting');
      expect(note?.text).toContain('ticket opened');
      expect(note?.statusChange).toEqual({ from: 'new', to: 'acting' });
      expect(note?.ticket).toBe('COST-42');
    });

    it('unknown ids: update returns null, getDetail null, getSnapshots empty', async () => {
      expect(await store.update(deps, 'nope', { name: 'x' })).toBeNull();
      expect(await store.getDetail(deps, 'nope')).toBeNull();
      expect(await store.getSnapshots(deps, 'nope')).toEqual([]);
    });

    it('persists specs/meta/history/snapshots to JSON; a reloaded store derives identical records', async () => {
      const specsDoc = rec(JSON.parse(await readFile(join(stateDir, 'baselines.json'), 'utf-8')));
      expect(specsDoc['version']).toBe(1);
      expect(Array.isArray(specsDoc['baselines'])).toBe(true);
      const meta = rec(specsDoc['meta']);
      const ec2Meta = rec(meta[ec2Id]);
      expect(ec2Meta['triageStatus']).toBe('acting');
      expect(ec2Meta['userTriaged']).toBe(true);

      const dataDoc = rec(JSON.parse(await readFile(join(stateDir, 'baselines-data.json'), 'utf-8')));
      expect(Array.isArray(rec(dataDoc['history'])[ec2Id])).toBe(true);
      expect(Array.isArray(rec(dataDoc['snapshots'])[ec2Id])).toBe(true);

      const before = await store.list(deps, {});
      const reloaded = new BaselineStore(stateDir);
      const after = await reloaded.list(deps, {});
      expect(after.total).toBe(before.total);
      expect(after.counts).toEqual(before.counts);
      expect(after.items.map(withoutBasis)).toEqual(before.items.map(withoutBasis));
      expect(await reloaded.getSnapshots(deps, ec2Id)).toEqual(await store.getSnapshots(deps, ec2Id));
      expect((await reloaded.getDetail(deps, ec2Id))?.dailyHistory).toEqual((await store.getDetail(deps, ec2Id))?.dailyHistory);
    });

    it('delete removes the baseline and prunes its persisted history and snapshots', async () => {
      await store.delete(deps, ec2Id);
      const res = await store.list(deps, {});
      expect(res.total).toBe(1);
      expect(res.items[0]?.scopeLabel).toBe('No Such Service');

      const dataDoc = rec(JSON.parse(await readFile(join(stateDir, 'baselines-data.json'), 'utf-8')));
      expect(rec(dataDoc['history'])[ec2Id]).toBeUndefined();
      expect(rec(dataDoc['snapshots'])[ec2Id]).toBeUndefined();

      const reloaded = new BaselineStore(stateDir);
      expect((await reloaded.list(deps, {})).total).toBe(1);
    });
  });

  describe('snapshot cap and same-day replacement', () => {
    const SEED_ID = 'seed-baseline-1';
    let store: BaselineStore;
    let deps: BaselineEngineDeps;

    const seedDate = (i: number): string => {
      const d = new Date(Date.UTC(2025, 0, 1));
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    };

    beforeAll(async () => {
      vi.setSystemTime(new Date(NOW_ISO));
      const stateDir = await newStateDir();
      deps = makeDeps(stateDir);
      const spec = {
        id: SEED_ID,
        source: 'manual',
        scope: { kind: 'filter', filters: { service: [EC2] } },
        basis: { costMetric: 'billed', rules: [] },
        basisSnapshotAt: NOW_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      };
      await writeFile(
        join(stateDir, 'baselines.json'),
        JSON.stringify({ version: 1, config: null, baselines: [spec], meta: {} }),
      );
      const snapshots = Array.from({ length: 400 }, (_, i) => ({
        date: seedDate(i), lower: 1, upper: 2, current: 1.5, potential: 0.5, realized: 0.5, status: 'in-band',
      }));
      await writeFile(
        join(stateDir, 'baselines-data.json'),
        JSON.stringify({ version: 1, history: { [SEED_ID]: [{ date: '2026-01-01', cost: 12 }] }, snapshots: { [SEED_ID]: snapshots } }),
      );
      store = new BaselineStore(stateDir);
    });

    it('recompute appends todays snapshot and enforces the MAX_SNAPSHOTS (365) cap', async () => {
      await store.recompute(deps, { only: SEED_ID });
      const snaps = await store.getSnapshots(deps, SEED_ID);
      expect(snaps.length).toBe(365);
      expect(String(snaps[snaps.length - 1]?.date)).toBe(TODAY);
      // 400 seeded + 1 new, capped at 365 → the oldest 36 fell off.
      expect(String(snaps[0]?.date)).toBe(seedDate(36));
      // The seeded single-point history was replaced by a real recompute.
      const detail = await store.getDetail(deps, SEED_ID);
      expect(detail?.dailyHistory.length ?? 0).toBeGreaterThan(50);
    });

    it('a same-day recompute replaces todays snapshot; a new day appends', async () => {
      await store.recompute(deps, { only: SEED_ID });
      let snaps = await store.getSnapshots(deps, SEED_ID);
      expect(snaps.length).toBe(365);
      expect(snaps.filter((s) => String(s.date) === TODAY).length).toBe(1);
      expect(String(snaps[0]?.date)).toBe(seedDate(36));

      vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));
      await store.recompute(deps, { only: SEED_ID });
      snaps = await store.getSnapshots(deps, SEED_ID);
      expect(snaps.length).toBe(365);
      expect(String(snaps[snaps.length - 1]?.date)).toBe('2026-03-05');
      expect(String(snaps[snaps.length - 2]?.date)).toBe(TODAY);
      expect(String(snaps[0]?.date)).toBe(seedDate(37));
    });
  });

  describe('getDrift', () => {
    let store: BaselineStore;
    let deps: BaselineEngineDeps;
    let id: string;

    beforeAll(async () => {
      vi.setSystemTime(new Date(NOW_ISO));
      const stateDir = await newStateDir();
      store = new BaselineStore(stateDir);
      deps = makeDeps(stateDir);
      await store.setConfig(DISCOVERY_CONFIG);
      const created = await store.create(deps, { scope: svcScope(EC2) });
      id = created.spec.id;
    });

    it('splits drift by child dimension, matching direct SQL over trailing and band windows', async () => {
      const rows = await store.getDrift(deps, id, 'account_id');
      const trailing = await sql(
        `SELECT SubAccountId AS a, SUM(BilledCost) AS c FROM ${GLOB}
         WHERE ServiceName = '${EC2}' AND ChargePeriodStart::DATE BETWEEN '${TRAILING_START}' AND '${QUERY_END}' GROUP BY 1`,
      );
      const band = await sql(`SELECT SubAccountId AS a, SUM(BilledCost) AS c FROM ${GLOB} WHERE ServiceName = '${EC2}' GROUP BY 1`);
      const tMap = new Map(trailing.map((r) => [str(r['a']), num(r['c'])]));
      const bMap = new Map(band.map((r) => [str(r['a']), num(r['c'])]));

      expect(new Set(rows.map((r) => r.child))).toEqual(new Set([...tMap.keys(), ...bMap.keys()]));
      for (const row of rows) {
        const cur = (tMap.get(row.child) ?? 0) / 30;
        const base = (bMap.get(row.child) ?? 0) / 365;
        expect(row.currentCost).toBeCloseTo(cur, 6);
        expect(row.bandWindowCost).toBeCloseTo(base, 6);
        expect(row.delta).toBeCloseTo(cur - base, 6);
      }
      for (let i = 1; i < rows.length; i++) {
        expect(Math.abs(rows[i]?.delta ?? 0)).toBeLessThanOrEqual(Math.abs(rows[i - 1]?.delta ?? 0));
      }
    });

    it('returns [] for an unknown id', async () => {
      expect(await store.getDrift(deps, 'nope', 'account_id')).toEqual([]);
    });
  });
});
