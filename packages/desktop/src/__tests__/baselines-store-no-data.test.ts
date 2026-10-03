import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asDimensionId, asProviderName, asTagValue } from '@costgoblin/core';
import type {
  BaselineRecomputeStatus,
  BaselineScope,
  CostScopeConfig,
  DimensionId,
  DimensionsConfig,
  ProviderSourceSpec,
  TagValue,
} from '@costgoblin/core';
import { BaselineStore, type BaselineEngineDeps } from '../main/baselines-store.js';
import type { RawRow } from '../main/duckdb-client.js';

// todayUtc() anchors every window and dates each new snapshot; pin it (Date
// only) so a snapshot appended by the run under test is recognisable.
const NOW = '2026-03-04T12:00:00.000Z';
const TODAY = '2026-03-04';
const AWS = asProviderName('aws-main');
const GCP = asProviderName('gcp-main');
// Synced months covering the tail of the default 365-day lookback.
const SYNCED = ['2026-02', '2026-03'];

const EC2 = 'Amazon Elastic Compute Cloud';
const S3 = 'Amazon Simple Storage Service';
const LAMBDA = 'AWS Lambda';

const MANUAL_ID = 'manual-ec2';
const VIEW_ID = 'manual-view';
const DISCOVERED_ID = 'discovered-s3';
// Not user-edited: discovery may prune it, but never re-snapshot it stale.
const UNTOUCHED_ID = 'discovered-lambda';
const LAGGED_ID = 'manual-lagged';
const BASIS = { costMetric: 'billed', rules: [] };

function entry(id: string, source: 'manual' | 'discovered', scope: unknown, basis: unknown = BASIS): Record<string, unknown> {
  return { id, source, scope, basis, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW };
}
const service = (name: string): unknown => ({ kind: 'filter', filters: { service: [name] } });

const BASELINES: Readonly<Record<string, Record<string, unknown>>> = {
  [MANUAL_ID]: { ...entry(MANUAL_ID, 'manual', service(EC2)), name: 'EC2 spend' },
  [VIEW_ID]: entry(VIEW_ID, 'manual', { kind: 'view', viewId: 'team-payments' }),
  [DISCOVERED_ID]: entry(DISCOVERED_ID, 'discovered', service(S3)),
  [UNTOUCHED_ID]: entry(UNTOUCHED_ID, 'discovered', service(LAMBDA)),
  // Its cost basis lags 70 days, which puts its window before every synced month.
  [LAGGED_ID]: entry(LAGGED_ID, 'manual', service('Amazon Relational Database Service'), { ...BASIS, lagDays: 70 }),
};

// A trend accumulates one snapshot per day and nothing can rebuild it.
function trend(current: number): readonly Record<string, unknown>[] {
  return ['2026-02-27', '2026-02-28', '2026-03-01'].map((date, i) => ({
    date, lower: current - 2, upper: current + 2, current: current + i, potential: 1, realized: 0.5, status: 'in-band',
  }));
}
function history(cost: number): readonly Record<string, unknown>[] {
  return ['2026-02-27', '2026-02-28', '2026-03-01'].map((date) => ({ date, cost }));
}

type ById = Readonly<Record<string, readonly Record<string, unknown>[]>>;
const SEEDED_SNAPSHOTS: ById = {
  [MANUAL_ID]: trend(15), [VIEW_ID]: trend(3), [DISCOVERED_ID]: trend(5), [UNTOUCHED_ID]: trend(7), [LAGGED_ID]: trend(9),
};
const SEEDED_HISTORY: ById = {
  [MANUAL_ID]: history(15), [VIEW_ID]: history(3), [DISCOVERED_ID]: history(5), [UNTOUCHED_ID]: history(7), [LAGGED_ID]: history(9),
};

function pick(src: ById, ids: readonly string[]): ById {
  return Object.fromEntries(ids.map((id) => [id, src[id] ?? []]));
}

const DEFAULT_IDS = [MANUAL_ID, VIEW_ID, DISCOVERED_ID];

/** The persisted state: `ids`' specs, each with history and a snapshot trend. */
function seed(ids: readonly string[] = DEFAULT_IDS, config: unknown = null): { specsText: string; data: Record<string, unknown>; dataText: string } {
  const specsText = JSON.stringify({
    version: 1,
    config,
    baselines: ids.map((id) => BASELINES[id]),
    meta: Object.fromEntries(ids.map((id) => [id, {
      // The discovered S3 baseline is noted, so a re-discovery that no longer
      // sees its tuple keeps it.
      triage: { notes: id === DISCOVERED_ID ? [{ at: NOW, text: 'lifecycle rule pending' }] : [] },
      bestAchieved: 1,
    }])),
  }, null, 2);
  const data = { version: 1, history: pick(SEEDED_HISTORY, ids), snapshots: pick(SEEDED_SNAPSHOTS, ids) };
  return { specsText, data, dataText: JSON.stringify(data, null, 2) };
}

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};
const costScope: CostScopeConfig = { costMetric: 'billed', rules: [], lagDays: 2 };

function svcScope(name: string): BaselineScope {
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  filters[asDimensionId('service')] = [asTagValue(name)];
  return { kind: 'filter', filters };
}

type Query = BaselineEngineDeps['runPreparedQuery'];
type QueryKind = 'probe' | 'totals' | 'discoveryDaily' | 'perBaseline';

/** Tell the store's queries apart by SQL shape (see the core query builders). */
function queryKind(sql: string): QueryKind {
  if (sql.includes('row_count')) return 'probe';
  if (sql.includes('per_day')) return 'discoveryDaily';
  if (sql.includes('group_name')) return 'perBaseline';
  return 'totals';
}

/** A fake DuckDB answering each query kind; unlisted kinds return no rows. */
function answering(answers: Partial<Record<QueryKind, (params: readonly unknown[]) => Promise<RawRow[]>>>): Query {
  return (sql, params) => answers[queryKind(sql)]?.(params) ?? Promise.resolve([]);
}

const rows = (...r: RawRow[]): (() => Promise<RawRow[]>) => () => Promise.resolve(r);
const noQueryExpected: Query = () => Promise.reject(new Error('no query expected without data'));

function makeDeps(
  stateDir: string,
  providers: readonly ProviderSourceSpec[],
  runPreparedQuery: Query = noQueryExpected,
  overrides: Partial<BaselineEngineDeps> = {},
): BaselineEngineDeps {
  return {
    dataDir: stateDir,
    stateDir,
    getFirstProviderName: () => Promise.resolve(providers[0]?.name ?? null),
    getQueryProviders: () => Promise.resolve(providers),
    getQueryDimensions: () => Promise.resolve(dimensions),
    getCostScope: () => Promise.resolve(costScope),
    getAccountMap: () => Promise.resolve(new Map<string, string>()),
    getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
    getOrgTreeConfig: () => Promise.resolve({ tree: [] }),
    runPreparedQuery,
    rollupStore: { getBuiltSignature: () => null, resolveSource: () => undefined },
    ...overrides,
  };
}

// Both states say nothing about any scope's spend: getQueryProviders maps an
// unreadable or briefly invalid costgoblin.yaml to [], and a provider whose
// months were pruned (or not yet synced) lists none in the window.
const NO_DATA_STATES: readonly { readonly label: string; readonly providers: readonly ProviderSourceSpec[]; readonly reason: RegExp }[] = [
  { label: 'no provider can be read', providers: [], reason: /^no billing provider .* — baselines left unchanged$/ },
  {
    label: 'no month in the window is synced',
    providers: [{ name: AWS, availablePeriods: ['2020-01'] }],
    reason: /^no billing data is synced locally for .* — baselines left unchanged$/,
  },
];

describe('BaselineStore recompute when cost data is missing', () => {
  const tmpDirs: string[] = [];

  /** A fresh state dir holding `seed(ids, config)`. */
  async function stateWith(ids: readonly string[] = DEFAULT_IDS, config: unknown = null) {
    const stateDir = await mkdtemp(join(tmpdir(), 'cg-baselines-nodata-'));
    tmpDirs.push(stateDir);
    const seeded = seed(ids, config);
    const specsPath = join(stateDir, 'baselines.json');
    const dataPath = join(stateDir, 'baselines-data.json');
    await writeFile(specsPath, seeded.specsText);
    await writeFile(dataPath, seeded.dataText);
    return {
      stateDir,
      store: new BaselineStore(stateDir),
      ...seeded,
      specsFile: (): Promise<string> => readFile(specsPath, 'utf-8'),
      dataFile: (): Promise<string> => readFile(dataPath, 'utf-8'),
      dataDoc: async (): Promise<unknown> => JSON.parse(await readFile(dataPath, 'utf-8')),
    };
  }

  /** Assert `id`'s stored history and snapshot trend are exactly as seeded. */
  async function expectUnchanged(store: BaselineStore, deps: BaselineEngineDeps, id: string): Promise<void> {
    const detail = await store.getDetail(deps, id);
    expect(detail?.snapshots).toEqual(SEEDED_SNAPSHOTS[id]);
    expect(detail?.dailyHistory).toEqual(SEEDED_HISTORY[id]);
  }

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  describe.each(NO_DATA_STATES)('when $label', ({ providers, reason }) => {
    it('a full recompute keeps every trend and history, and fails with the reason', async () => {
      const { stateDir, store, data, dataText, specsText, specsFile, dataFile, dataDoc } = await stateWith();
      const deps = makeDeps(stateDir, providers);
      const statuses: BaselineRecomputeStatus[] = [];
      store.onStatusChanged((s) => { statuses.push(s); });

      await store.recompute(deps);

      // No blanked manual/view trend, and no snapshot for today computed from
      // the discovered baseline's stale history — on disk or in memory.
      expect(await dataDoc()).toEqual(data);
      for (const id of DEFAULT_IDS) await expectUnchanged(store, deps, id);
      expect(store.getStatus()).toEqual({ state: 'error', lastRun: null, message: expect.stringMatching(reason) });
      // The click shows as a run before it fails.
      expect(statuses[1]?.state).toBe('running');
      expect(statuses.at(-1)?.state).toBe('error');
      // A failed run writes nothing (a save would also re-seed the specs' basis).
      expect(await dataFile()).toBe(dataText);
      expect(await specsFile()).toBe(specsText);

      // The next save (any edit) persists memory as it is — which must be intact.
      await store.update(deps, MANUAL_ID, { name: 'EC2 spend (renamed)' });
      expect(await dataDoc()).toEqual(data);
    });

    it('a start-fresh recompute wipes no discovered baseline it could not rediscover', async () => {
      const { stateDir, store, specsText, specsFile } = await stateWith();
      const deps = makeDeps(stateDir, providers);

      await store.recompute(deps, { startFresh: true });

      const { items } = await store.list(deps, {});
      expect(items.map((r) => r.spec.id).sort()).toEqual([...DEFAULT_IDS].sort());
      expect(await specsFile()).toBe(specsText);
      expect(store.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(reason) });
    });

    it('recomputing a single baseline keeps its trend and history, and fails with the reason', async () => {
      const { stateDir, store, specsText, specsFile } = await stateWith();
      const deps = makeDeps(stateDir, providers);

      await store.recompute(deps, { only: VIEW_ID });

      await expectUnchanged(store, deps, VIEW_ID);
      expect(await specsFile()).toBe(specsText);
      expect(store.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(reason) });
    });

    it('creating a baseline still works, and leaves the other trends intact', async () => {
      const { stateDir, store, data, dataDoc } = await stateWith();
      const deps = makeDeps(stateDir, providers);

      const record = await store.create(deps, { scope: svcScope(LAMBDA) });

      expect(record.stats).toBeNull();
      expect(record.status).toBe('insufficient-data');
      expect(await dataDoc()).toMatchObject(data);
    });
  });

  describe('with data synced', () => {
    const synced: readonly ProviderSourceSpec[] = [{ name: AWS, availablePeriods: SYNCED }];
    const discoveredS3 = {
      totals: rows({ service: S3, total: 5000 }),
      discoveryDaily: rows({ date: '2026-03-01', service: S3, cost: 10 }),
      perBaseline: rows({ date: '2026-03-01', group_name: 'x', cost: 20 }),
    };

    it('a query that finds no spend still drops the stale trend', async () => {
      // The data is there and says these scopes spent nothing — the case
      // finalizeFromHistory's empty-history branch is for.
      const { stateDir, store, dataDoc } = await stateWith();
      const deps = makeDeps(stateDir, synced, answering({}));

      await store.recompute(deps);

      expect(store.getStatus()).toMatchObject({ state: 'idle' });
      // The noted discovered baseline vanished from discovery: kept, but blanked.
      expect(await dataDoc()).toEqual({
        version: 1,
        history: { [MANUAL_ID]: [], [VIEW_ID]: [], [DISCOVERED_ID]: [] },
        snapshots: {},
      });
    });

    it('a baseline whose own window has no data is left as it was while the rest refresh', async () => {
      const { stateDir, store } = await stateWith([...DEFAULT_IDS, LAGGED_ID]);
      const deps = makeDeps(stateDir, synced, answering(discoveredS3));

      await store.recompute(deps);

      expect(store.getStatus()).toMatchObject({ state: 'idle' });
      await expectUnchanged(store, deps, LAGGED_ID);
      const manual = await store.getDetail(deps, MANUAL_ID);
      expect(manual?.dailyHistory).toEqual([{ date: '2026-03-01', cost: 20 }]);
      expect(manual?.snapshots.map((s) => String(s.date))).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', TODAY]);
    });

    it('a current lag that puts discovery before the synced months still refreshes baselines whose own window has data', async () => {
      const { stateDir, store } = await stateWith([...DEFAULT_IDS, UNTOUCHED_ID]);
      const deps = makeDeps(stateDir, synced, answering(discoveredS3), {
        getCostScope: () => Promise.resolve({ ...costScope, lagDays: 60 }),
      });

      await store.recompute(deps);

      expect(store.getStatus()).toMatchObject({ state: 'idle' });
      expect((await store.getDetail(deps, MANUAL_ID))?.dailyHistory).toEqual([{ date: '2026-03-01', cost: 20 }]);
      // Discovery didn't run: no snapshot from the untouched one's stale history.
      await expectUnchanged(store, deps, UNTOUCHED_ID);
    });

    it('a provider with nothing synced in the window leaves the scopes it may hold unchanged', async () => {
      const { stateDir, store } = await stateWith([...DEFAULT_IDS, UNTOUCHED_ID]);
      const providers: readonly ProviderSourceSpec[] = [{ name: AWS, availablePeriods: SYNCED }, { name: GCP, availablePeriods: [] }];
      // Only the EC2 scope has rows in the provider that is there.
      const deps = makeDeps(stateDir, providers, answering({
        perBaseline: (params) => Promise.resolve(params.includes(EC2) ? [{ date: '2026-03-01', group_name: EC2, cost: 20 }] : []),
      }));

      await store.recompute(deps);

      expect(store.getStatus()).toMatchObject({ state: 'idle' });
      expect((await store.getDetail(deps, MANUAL_ID))?.dailyHistory).toEqual([{ date: '2026-03-01', cost: 20 }]);
      // No rows, but gcp-main is missing: neither zero spend nor vanished.
      for (const id of [VIEW_ID, DISCOVERED_ID, UNTOUCHED_ID]) await expectUnchanged(store, deps, id);
    });

    it('a grain that resolves to no dimension never re-snapshots discovered baselines from stale history', async () => {
      // An override naming a dimension that is not enabled.
      const { stateDir, store } = await stateWith([...DEFAULT_IDS, UNTOUCHED_ID], { grainDimensions: ['region'] });
      const deps = makeDeps(stateDir, synced, answering(discoveredS3));

      await store.recompute(deps);

      expect(store.getStatus()).toMatchObject({ state: 'idle' });
      await expectUnchanged(store, deps, UNTOUCHED_ID);
      // The noted one is refreshed by its own query instead.
      expect((await store.getDetail(deps, DISCOVERED_ID))?.dailyHistory).toEqual([{ date: '2026-03-01', cost: 20 }]);
    });

    it('a start-fresh recompute that cannot resolve a grain wipes nothing and fails', async () => {
      const { stateDir, store, specsText, specsFile } = await stateWith([...DEFAULT_IDS, UNTOUCHED_ID], { grainDimensions: ['region'] });
      const deps = makeDeps(stateDir, synced, answering(discoveredS3));

      await store.recompute(deps, { startFresh: true });

      expect(store.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/discovery grain/) });
      expect(await specsFile()).toBe(specsText);
      expect((await store.list(deps, {})).items).toHaveLength(4);
    });

    it('a failed cardinality probe fails the run instead of widening the grain', async () => {
      const { stateDir, store, specsText, dataText, specsFile, dataFile } = await stateWith([...DEFAULT_IDS, UNTOUCHED_ID]);
      const deps = makeDeps(stateDir, synced, answering({ ...discoveredS3, probe: () => Promise.reject(new Error('Query cancelled')) }));

      await store.recompute(deps);

      expect(store.getStatus()).toMatchObject({ state: 'error', message: 'Query cancelled' });
      expect(await specsFile()).toBe(specsText);
      expect(await dataFile()).toBe(dataText);
    });

    it('a start-fresh recompute whose discovery fails leaves every discovered baseline in place', async () => {
      const { stateDir, store, specsFile } = await stateWith([...DEFAULT_IDS, UNTOUCHED_ID]);
      const deps = makeDeps(stateDir, synced, answering({ ...discoveredS3, totals: () => Promise.reject(new Error('Query cancelled')) }));

      await store.recompute(deps, { startFresh: true });

      expect(store.getStatus()).toMatchObject({ state: 'error', message: 'Query cancelled' });
      // Not wiped in memory either, so the next save can't persist a wipe.
      await store.update(deps, MANUAL_ID, { name: 'EC2 spend (renamed)' });
      const ids = (await store.list(deps, {})).items.map((r) => r.spec.id);
      expect(ids.sort()).toEqual([...DEFAULT_IDS, UNTOUCHED_ID].sort());
      for (const id of [DISCOVERED_ID, UNTOUCHED_ID]) expect(await specsFile()).toContain(id);
    });

    it('a user-edited discovered baseline under the auto-ignore threshold keeps its trend and is refreshed', async () => {
      const { stateDir, store } = await stateWith();
      // S3 fell to $50 over the year: the daily discovery query no longer fetches it.
      const deps = makeDeps(stateDir, synced, answering({
        totals: rows({ service: S3, total: 50 }),
        perBaseline: (params) => Promise.resolve(params.includes(S3) ? [{ date: '2026-03-01', group_name: S3, cost: 0.1 }] : []),
      }));

      await store.recompute(deps);

      const detail = await store.getDetail(deps, DISCOVERED_ID);
      expect(detail?.dailyHistory).toEqual([{ date: '2026-03-01', cost: 0.1 }]);
      expect(detail?.snapshots.slice(0, 3)).toEqual(SEEDED_SNAPSHOTS[DISCOVERED_ID]);
      expect(detail?.snapshots.map((s) => String(s.date)).at(-1)).toBe(TODAY);
    });

    it('discovered baselines take the cost basis their history was queried with', async () => {
      const { stateDir, store } = await stateWith();
      let reads = 0;
      // The user saves a new cost scope while discovery runs.
      const deps = makeDeps(stateDir, synced, answering(discoveredS3), {
        getCostScope: () => Promise.resolve(reads++ === 0 ? costScope : { ...costScope, costMetric: 'effective', lagDays: 9 }),
      });

      await store.recompute(deps);

      const spec = (await store.getDetail(deps, DISCOVERED_ID))?.record.spec;
      expect(spec?.basis).toMatchObject({ costMetric: 'billed', lagDays: 2 });
    });

    it('drift reports nothing when the trailing window has no synced data', async () => {
      const { stateDir, store } = await stateWith();
      // Sync stopped in mid-2025: the band window reads data, the trailing one can't.
      const deps = makeDeps(stateDir, [{ name: AWS, availablePeriods: ['2025-06'] }], answering({
        perBaseline: rows({ date: '2025-06-15', group_name: 'i-abc', cost: 365 }),
      }));

      expect(await store.getDrift(deps, MANUAL_ID, 'service')).toEqual([]);
    });

    it('a create whose query fails leaves no phantom baseline behind', async () => {
      const { stateDir, store } = await stateWith();
      let fail = true;
      const deps = makeDeps(stateDir, synced, answering({
        perBaseline: () => (fail ? Promise.reject(new Error('duckdb exploded')) : Promise.resolve([])),
      }));

      await expect(store.create(deps, { scope: svcScope(LAMBDA) })).rejects.toThrow('duckdb exploded');
      expect((await store.list(deps, {})).items).toHaveLength(DEFAULT_IDS.length);

      // The retry isn't rejected as a duplicate scope.
      fail = false;
      const record = await store.create(deps, { scope: svcScope(LAMBDA) });
      expect(record.spec.scope).toEqual(svcScope(LAMBDA));
    });
  });
});
