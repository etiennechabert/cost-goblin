import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId, asProviderName, asTagValue } from '@costgoblin/core';
import type {
  BaselineScope,
  CostScopeConfig,
  DimensionId,
  DimensionsConfig,
  ProviderSourceSpec,
  TagValue,
} from '@costgoblin/core';
import { BaselineStore, type BaselineEngineDeps } from '../main/baselines-store.js';

// todayUtc() anchors every window and dates each new snapshot; pin it (Date
// only) so a snapshot appended by the run under test is recognisable.
const NOW = '2026-03-04T12:00:00.000Z';
const PROVIDER = asProviderName('aws-main');

const MANUAL_ID = 'manual-ec2';
const VIEW_ID = 'manual-view';
const DISCOVERED_ID = 'discovered-s3';
const BASIS = { costMetric: 'billed', rules: [] };

const SPECS_TEXT = JSON.stringify({
  version: 1,
  config: null,
  baselines: [
    {
      id: MANUAL_ID, name: 'EC2 spend', source: 'manual',
      scope: { kind: 'filter', filters: { service: ['Amazon Elastic Compute Cloud'] } },
      basis: BASIS, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW,
    },
    {
      id: VIEW_ID, source: 'manual',
      scope: { kind: 'view', viewId: 'team-payments' },
      basis: BASIS, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW,
    },
    {
      id: DISCOVERED_ID, source: 'discovered',
      scope: { kind: 'filter', filters: { service: ['Amazon Simple Storage Service'] } },
      basis: BASIS, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW,
    },
  ],
  meta: {
    [MANUAL_ID]: { triage: { notes: [] }, bestAchieved: 12.5 },
    [VIEW_ID]: { triage: { notes: [] }, bestAchieved: 3 },
    // Noted, so a re-discovery that no longer sees the tuple would keep it.
    [DISCOVERED_ID]: { triage: { notes: [{ at: NOW, text: 'lifecycle rule pending' }] }, bestAchieved: 4 },
  },
}, null, 2);

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
const SEEDED_SNAPSHOTS: ById = { [MANUAL_ID]: trend(15), [VIEW_ID]: trend(3), [DISCOVERED_ID]: trend(5) };
const SEEDED_HISTORY: ById = { [MANUAL_ID]: history(15), [VIEW_ID]: history(3), [DISCOVERED_ID]: history(5) };
const DATA_TEXT = JSON.stringify({ version: 1, history: SEEDED_HISTORY, snapshots: SEEDED_SNAPSHOTS }, null, 2);

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};
const costScope: CostScopeConfig = { costMetric: 'billed', rules: [], lagDays: 2 };

function svcScope(service: string): BaselineScope {
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  filters[asDimensionId('service')] = [asTagValue(service)];
  return { kind: 'filter', filters };
}

function makeDeps(
  stateDir: string,
  providers: readonly ProviderSourceSpec[],
  runPreparedQuery: BaselineEngineDeps['runPreparedQuery'] = () => Promise.reject(new Error('no query expected without data')),
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
  };
}

// Both states say nothing about any scope's spend: getQueryProviders maps an
// unreadable or briefly invalid costgoblin.yaml to [], and a provider whose
// months were pruned (or not yet synced) lists none in the window.
const NO_DATA_STATES: readonly { readonly label: string; readonly providers: readonly ProviderSourceSpec[]; readonly reason: RegExp }[] = [
  { label: 'no provider can be read', providers: [], reason: /no billing provider/ },
  { label: 'no month in the window is synced', providers: [{ name: PROVIDER, availablePeriods: ['2020-01'] }], reason: /no billing data is synced locally/ },
];

describe('BaselineStore recompute when no cost data can be read', () => {
  const tmpDirs: string[] = [];
  let stateDir: string;
  let specsPath: string;
  let dataPath: string;

  const readDataDoc = async (): Promise<unknown> => JSON.parse(await readFile(dataPath, 'utf-8'));

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cg-baselines-nodata-'));
    tmpDirs.push(stateDir);
    specsPath = join(stateDir, 'baselines.json');
    dataPath = join(stateDir, 'baselines-data.json');
    await writeFile(specsPath, SPECS_TEXT);
    await writeFile(dataPath, DATA_TEXT);
  });

  describe.each(NO_DATA_STATES)('when $label', ({ providers, reason }) => {
    it('a full recompute keeps every trend and history, and fails with the reason', async () => {
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir, providers);

      await store.recompute(deps);

      // No blanked manual/view trend, and no snapshot for today computed from
      // the discovered baseline's stale history — on disk or in memory.
      expect(await readDataDoc()).toEqual({ version: 1, history: SEEDED_HISTORY, snapshots: SEEDED_SNAPSHOTS });
      for (const id of [MANUAL_ID, VIEW_ID, DISCOVERED_ID]) {
        const detail = await store.getDetail(deps, id);
        expect(detail?.snapshots).toEqual(SEEDED_SNAPSHOTS[id]);
        expect(detail?.dailyHistory).toEqual(SEEDED_HISTORY[id]);
      }
      const status = store.getStatus();
      expect(status).toMatchObject({ state: 'error', lastRun: null });
      expect(status.state === 'error' ? status.message : '').toMatch(reason);
      expect(status.state === 'error' ? status.message : '').toMatch(/baselines left unchanged/);
      // A failed run writes nothing.
      expect(await readFile(dataPath, 'utf-8')).toBe(DATA_TEXT);
      expect(await readFile(specsPath, 'utf-8')).toBe(SPECS_TEXT);

      // The next save (any edit) persists memory as it is — which must be intact.
      await store.update(deps, MANUAL_ID, { name: 'EC2 spend (renamed)' });
      expect(await readDataDoc()).toEqual({ version: 1, history: SEEDED_HISTORY, snapshots: SEEDED_SNAPSHOTS });
    });

    it('a start-fresh recompute wipes no discovered baseline it could not rediscover', async () => {
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir, providers);

      await store.recompute(deps, { startFresh: true });

      const { items } = await store.list(deps, {});
      expect(items.map((r) => r.spec.id).sort()).toEqual([DISCOVERED_ID, MANUAL_ID, VIEW_ID].sort());
      expect(await readFile(specsPath, 'utf-8')).toBe(SPECS_TEXT);
      expect(store.getStatus()).toMatchObject({ state: 'error' });
    });

    it('recomputing a single baseline keeps its trend and fails with the reason', async () => {
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir, providers);

      await store.recompute(deps, { only: VIEW_ID });

      expect(await store.getSnapshots(deps, VIEW_ID)).toEqual(SEEDED_SNAPSHOTS[VIEW_ID]);
      expect(await readFile(dataPath, 'utf-8')).toBe(DATA_TEXT);
      const status = store.getStatus();
      expect(status).toMatchObject({ state: 'error' });
      expect(status.state === 'error' ? status.message : '').toMatch(reason);
    });

    it('creating a baseline still works, and leaves the other trends intact', async () => {
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir, providers);

      const record = await store.create(deps, { scope: svcScope('AWS Lambda') });

      expect(record.stats).toBeNull();
      expect(record.status).toBe('insufficient-data');
      const doc = await readDataDoc();
      expect(doc).toMatchObject({ history: SEEDED_HISTORY, snapshots: SEEDED_SNAPSHOTS });
    });
  });

  it('a query over synced data that finds no spend still drops the stale trend', async () => {
    // The data is there and says this scope spent nothing — the case
    // finalizeFromHistory's empty-history branch is for.
    const store = new BaselineStore(stateDir);
    const deps = makeDeps(stateDir, [{ name: PROVIDER, availablePeriods: ['2026-01', '2026-02', '2026-03'] }], () => Promise.resolve([]));

    await store.recompute(deps);

    expect(store.getStatus()).toMatchObject({ state: 'idle' });
    const detail = await store.getDetail(deps, MANUAL_ID);
    expect(detail?.dailyHistory).toEqual([]);
    expect(detail?.snapshots).toEqual([]);
    // The noted discovered baseline vanished from discovery: kept, but blanked.
    expect(await readDataDoc()).toEqual({
      version: 1,
      history: { [MANUAL_ID]: [], [VIEW_ID]: [], [DISCOVERED_ID]: [] },
      snapshots: {},
    });
  });
});
