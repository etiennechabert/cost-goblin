import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asDimensionId,
  asProviderName,
  asTagValue,
  computeOrgAccountsDigest,
  computeShapeSignature,
} from '@costgoblin/core';
import type {
  BaselineRecomputeStatus,
  BaselineRecord,
  BaselineScope,
  BaselinesDiscoveryConfig,
  Clock,
  CostScopeConfig,
  DimensionId,
  DimensionsConfig,
  ProviderSourceSpec,
  TagValue,
} from '@costgoblin/core';
import { BaselineStore, type BaselineEngineDeps } from '../main/baselines-store.js';
import type { RawRow } from '../main/duckdb-client.js';

/** BaselineStore paths the DuckDB-backed suite (baselines-store.test.ts) does
 *  not reach: hand-edited or corrupt state files, list filters and sorts,
 *  discovery's skip/fallback branches, rollup routing decisions and drift
 *  edge cases. Queries are answered by a scripted engine keyed on the SQL
 *  builder's output shape, so each case controls exactly what "the data"
 *  returns. */

const PROVIDER = asProviderName('aws-main');
// 2026-03-04; with the default 2-day lag every window ends 2026-03-02.
const NOW = Date.UTC(2026, 2, 4, 12);
const clock: Clock = () => NOW;
const QUERY_END = '2026-03-02';
const LOOKBACK_START = '2025-03-02';
// getDrift's windows: end - (30 - 1) days, end - (365 - 1) days.
const TRAILING_START = '2026-02-01';
const BAND_START = '2025-03-03';

const DIMS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [],
};
const COST_SCOPE: CostScopeConfig = { costMetric: 'billed', rules: [], lagDays: 2 };
const SYNCED: readonly ProviderSourceSpec[] = [{ name: PROVIDER, type: 'aws', availablePeriods: ['2025-12', '2026-01', '2026-02', '2026-03'] }];

interface QueryCall { readonly sql: string; readonly params: readonly unknown[]; readonly materialized: boolean }
type Answer = { readonly rows: readonly RawRow[] } | { readonly reject: unknown };

/** Stand-in for the DuckDB worker: records every prepared query and answers it
 *  by which builder produced it. */
class FakeEngine {
  readonly calls: QueryCall[] = [];
  cardinality: Answer = { rows: [{ account_id: 3n, service: 4n, row_count: 10_000n }] };
  totals: readonly RawRow[] = [];
  daily: readonly RawRow[] = [];
  dailyCosts: (params: readonly unknown[]) => readonly RawRow[] | Promise<readonly RawRow[]> = () => [];

  async run(sql: string, params: readonly unknown[], materialized?: boolean): Promise<RawRow[]> {
    this.calls.push({ sql, params, materialized: materialized === true });
    if (sql.includes('AS row_count')) {
      const answer = this.cardinality;
      if ('reject' in answer) throw answer.reject;
      return [...answer.rows];
    }
    if (sql.startsWith('WITH per_day')) return [...this.daily];
    if (sql.includes('AS total')) return [...this.totals];
    if (sql.includes('AS group_name')) return [...await this.dailyCosts(params)];
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  }

  callsOf(kind: 'probe' | 'totals' | 'discovery' | 'dailyCosts'): QueryCall[] {
    return this.calls.filter(c => {
      if (kind === 'probe') return c.sql.includes('AS row_count');
      if (kind === 'discovery') return c.sql.startsWith('WITH per_day');
      if (kind === 'totals') return !c.sql.startsWith('WITH per_day') && c.sql.includes('AS total');
      return c.sql.includes('AS group_name');
    });
  }
}

function makeDeps(stateDir: string, engine: FakeEngine, overrides: Partial<BaselineEngineDeps> = {}): BaselineEngineDeps {
  return {
    dataDir: '/data',
    stateDir,
    getFirstProviderName: () => Promise.resolve(PROVIDER),
    getQueryProviders: () => Promise.resolve(SYNCED),
    getQueryDimensions: () => Promise.resolve(DIMS),
    getCostScope: () => Promise.resolve(COST_SCOPE),
    getAccountMap: () => Promise.resolve(new Map<string, string>()),
    getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
    getOrgTreeConfig: () => Promise.resolve({ tree: [] }),
    runPreparedQuery: (sql, params, materialized) => engine.run(sql, params, materialized),
    rollupStore: { getBuiltSignature: () => null, resolveSource: () => undefined },
    ...overrides,
  };
}

function filterScope(entries: Record<string, readonly string[]>): BaselineScope {
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  for (const [dim, values] of Object.entries(entries)) filters[asDimensionId(dim)] = values.map(asTagValue);
  return { kind: 'filter', filters };
}

/** A persisted spec as baselines.json stores it. */
function specJson(id: string, scope: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    source: 'manual',
    scope,
    basis: { costMetric: 'billed', rules: [], lagDays: 2 },
    basisSnapshotAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const svcSpec = (id: string, service: string): Record<string, unknown> => specJson(id, { kind: 'filter', filters: { service: [service] } });

/** `count` consecutive daily points ending on `end`, cost by day index. */
function series(count: number, end: string, cost: (i: number) => number): { date: string; cost: number }[] {
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(endMs - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    cost: cost(i),
  }));
}

async function writeState(dir: string, specs: unknown, data?: unknown): Promise<void> {
  await writeFile(join(dir, 'baselines.json'), typeof specs === 'string' ? specs : JSON.stringify(specs));
  if (data !== undefined) await writeFile(join(dir, 'baselines-data.json'), typeof data === 'string' ? data : JSON.stringify(data));
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return { ...parsed };
}

function keysOf(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
}

function ids(records: readonly BaselineRecord[]): string[] {
  return records.map(r => r.spec.id);
}

function recordOf(records: readonly BaselineRecord[], id: string): BaselineRecord {
  const record = records.find(r => r.spec.id === id);
  if (record === undefined) throw new Error(`no record ${id}`);
  return record;
}

function filterValues(scope: BaselineScope): Record<string, string[]> {
  if (scope.kind !== 'filter') return {};
  return Object.fromEntries(Object.entries(scope.filters).map(([k, v]) => [k, (v ?? []).map(String)]));
}

const tmpDirs: string[] = [];
async function newStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cg-baselines-edge-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

describe('BaselineStore — persisted state', () => {
  it('ignores state files that are valid JSON but not objects', async () => {
    const dir = await newStateDir();
    await writeState(dir, '[1, 2]', '"not an object"');
    const store = new BaselineStore(dir, clock);

    const result = await store.list(makeDeps(dir, new FakeEngine()), {});

    expect(result.total).toBe(0);
    expect(result.counts.all).toBe(0);
    expect(store.getConfigState().isCustom).toBe(false);
  });

  it('reads a specs file with no baselines list and a data file with no history as empty', async () => {
    const dir = await newStateDir();
    await writeState(dir, { version: 1, meta: {} }, { version: 1 });
    const store = new BaselineStore(dir, clock);

    await expect(store.list(makeDeps(dir, new FakeEngine()), {})).resolves.toMatchObject({ total: 0, items: [] });
  });

  it('keeps every valid baseline and drops only the specs that fail validation', async () => {
    const dir = await newStateDir();
    await writeState(dir, {
      baselines: [
        svcSpec('svc', 'EC2'),
        specJson('view', { kind: 'view', viewId: 'v-finance' }),
        // Tag dimensions churn, so a tag-scoped baseline is refused on load.
        specJson('tagged', { kind: 'filter', filters: { tag_team: ['payments'] } }),
        'not a spec',
      ],
    });
    const store = new BaselineStore(dir, clock);

    const result = await store.list(makeDeps(dir, new FakeEngine()), {});

    expect(ids(result.items).sort()).toEqual(['svc', 'view']);
    expect(recordOf(result.items, 'view').scopeLabel).toBe('View: v-finance');
  });

  it('restores triage metadata and maps the pre-lifecycle status names', async () => {
    const dir = await newStateDir();
    await writeState(dir, {
      baselines: [svcSpec('svc', 'EC2'), svcSpec('rds', 'RDS'), svcSpec('s3', 'S3')],
      meta: {
        svc: {
          triage: {
            notes: [
              { at: '2026-02-01T10:00:00.000Z', text: 'escalated', statusChange: { from: 'interesting', to: 'bogus' }, ticket: 'FIN-12' },
              'not a note',
              { at: 3, text: null },
            ],
          },
          bestAchieved: 12.5,
          triageStatus: 'in-progress',
          userTriaged: true,
        },
        rds: { triageStatus: 'auto-ignored', triage: {} },
        s3: { triageStatus: 'nonsense' },
        orphan: 'not an object',
      },
    });
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, new FakeEngine());

    const { items, counts } = await store.list(deps, {});

    const svc = recordOf(items, 'svc');
    expect(svc.triageStatus).toBe('acting');
    expect(svc.bestAchieved).toBe(12.5);
    expect(svc.triage.notes).toEqual([
      { at: '2026-02-01T10:00:00.000Z', text: 'escalated', statusChange: { from: 'tracking', to: 'new' }, ticket: 'FIN-12' },
      { at: '', text: '' },
    ]);
    expect(recordOf(items, 'rds').triageStatus).toBe('ignored');
    expect(recordOf(items, 'rds').triage.notes).toEqual([]);
    expect(recordOf(items, 's3').triageStatus).toBe('new');
    expect(counts).toMatchObject({ all: 3, open: 2, acting: 1, ignored: 1, new: 1 });

    // The user-set status survives the next save as an explicit pin.
    await store.setConfig(store.effectiveConfig());
    const meta = (await readJsonObject(join(dir, 'baselines.json')))['meta'];
    expect(meta).toMatchObject({ svc: { triageStatus: 'acting', userTriaged: true, bestAchieved: 12.5 } });
  });

  it('reads stored history and snapshots, tolerating malformed entries', async () => {
    const dir = await newStateDir();
    await writeState(dir, { baselines: [svcSpec('svc', 'EC2'), svcSpec('rds', 'RDS')] }, {
      history: { svc: [{ date: '2026-02-01', cost: 5 }, 'junk', { date: '2026-02-02', cost: 'x' }], rds: 'not a list' },
      snapshots: {
        svc: [
          { date: '2026-03-01', lower: 1, upper: 2, current: 3, potential: 4, realized: 5, status: 'over' },
          { date: '2026-03-02', status: 'sideways' },
          'junk',
        ],
        rds: 'not a list',
      },
    });
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, new FakeEngine());

    const svc = await store.getDetail(deps, 'svc');
    expect(svc?.dailyHistory).toEqual([{ date: '2026-02-01', cost: 5 }, { date: '2026-02-02', cost: 0 }]);
    expect(svc?.snapshots).toEqual([
      { date: '2026-03-01', lower: 1, upper: 2, current: 3, potential: 4, realized: 5, status: 'over' },
      { date: '2026-03-02', lower: 0, upper: 0, current: 0, potential: 0, realized: 0, status: 'insufficient-data' },
    ]);
    const rds = await store.getDetail(deps, 'rds');
    expect(rds?.dailyHistory).toEqual([]);
    expect(rds?.snapshots).toEqual([]);
    await expect(store.getSnapshots(deps, 'rds')).resolves.toEqual([]);
  });

  it('falls back field by field from a hand-edited discovery config', async () => {
    const dir = await newStateDir();
    await writeState(dir, {
      config: { lookbackDays: 'a year', windowDays: 0, lowerPct: 'low', upperPct: 95, minMonthlyCost: 50, minSavings: 'none', reopenPct: 20, grainDimensions: 'service' },
      baselines: [],
    });
    const store = new BaselineStore(dir, clock);
    await store.list(makeDeps(dir, new FakeEngine()), {});

    expect(store.getConfigState()).toEqual({
      isCustom: true,
      config: { lookbackDays: 365, windowDays: 30, lowerPct: 10, upperPct: 95, minMonthlyCost: 50, minSavings: 0, reopenPct: 20, grainDimensions: [] },
    });

    const other = await newStateDir();
    await writeState(other, {
      config: { lookbackDays: 90, windowDays: 14, lowerPct: 5, minMonthlyCost: 'cheap', minSavings: 10, reopenPct: 'often', grainDimensions: ['service', 7] },
      baselines: [],
    });
    const otherStore = new BaselineStore(other, clock);
    await otherStore.list(makeDeps(other, new FakeEngine()), {});

    expect(otherStore.getConfigState().config).toEqual({
      lookbackDays: 90, windowDays: 14, lowerPct: 5, upperPct: 90, minMonthlyCost: 100, minSavings: 10, reopenPct: 15, grainDimensions: ['service'],
    });
  });

  it('drops the history and snapshots of baselines that no longer exist on the next save', async () => {
    const dir = await newStateDir();
    const pts = series(3, QUERY_END, () => 1);
    await writeState(dir, { baselines: [svcSpec('svc', 'EC2')] }, { history: { svc: pts, ghost: pts }, snapshots: { ghost: [] } });
    const store = new BaselineStore(dir, clock);
    await store.list(makeDeps(dir, new FakeEngine()), {});

    await store.resetConfig();

    const data = await readJsonObject(join(dir, 'baselines-data.json'));
    expect(keysOf(data['history'])).toEqual(['svc']);
    expect(keysOf(data['snapshots'])).toEqual([]);
  });
});

describe('BaselineStore — list', () => {
  it('filters by org-tree owner and by dimension, labelling accounts by name', async () => {
    const dir = await newStateDir();
    await writeState(dir, {
      baselines: [
        specJson('acct', { kind: 'filter', filters: { account_id: ['111111111111'] } }),
        svcSpec('svc', 'EC2'),
        specJson('view', { kind: 'view', viewId: 'v-1' }),
      ],
    });
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, new FakeEngine(), {
      getAccountMap: () => Promise.resolve(new Map([['111111111111', 'payments']])),
      getOrgTreeConfig: () => Promise.resolve({ tree: [{ name: 'eng', children: [{ name: 'payments' }] }] }),
    });

    const all = await store.list(deps, {});
    expect(recordOf(all.items, 'acct').scopeLabel).toBe('payments');
    expect(recordOf(all.items, 'acct').ownerPath).toEqual(['eng', 'payments']);
    expect(recordOf(all.items, 'svc').ownerPath).toBeUndefined();

    expect(ids((await store.list(deps, { owner: 'eng' })).items)).toEqual(['acct']);
    expect(ids((await store.list(deps, { owner: 'finance' })).items)).toEqual([]);
    expect(ids((await store.list(deps, { dimension: asDimensionId('account_id') })).items)).toEqual(['acct']);
    expect(ids((await store.list(deps, { dimension: asDimensionId('service') })).items)).toEqual(['svc']);
  });

  it('sorts by realized saving, by current spend and by scope label', async () => {
    const dir = await newStateDir();
    await writeState(dir, {
      baselines: [svcSpec('flat', 'Flat'), svcSpec('dropped', 'Dropped'), svcSpec('high', 'High')],
    }, {
      history: {
        flat: series(90, QUERY_END, () => 20),
        // Ran at $100/day, then fell to $50/day for the last 30 days.
        dropped: series(90, QUERY_END, i => (i < 60 ? 100 : 50)),
        high: series(90, QUERY_END, () => 70),
      },
    });
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, new FakeEngine());

    const byRealized = (await store.list(deps, { sortBy: 'realized' })).items;
    expect(byRealized[0]?.spec.id).toBe('dropped');
    expect(byRealized[0]?.realizedDaily).toBeGreaterThan(40);

    expect(ids((await store.list(deps, { sortBy: 'current', sortDir: 'asc' })).items)).toEqual(['flat', 'dropped', 'high']);
    expect(ids((await store.list(deps, { sortBy: 'scope', sortDir: 'asc' })).items)).toEqual(['dropped', 'flat', 'high']);
    expect(ids((await store.list(deps, { sortBy: 'scope' })).items)).toEqual(['high', 'flat', 'dropped']);
  });
});

describe('BaselineStore — manual baselines', () => {
  let dir = '';
  let engine: FakeEngine;
  let store: BaselineStore;
  let deps: BaselineEngineDeps;

  beforeEach(async () => {
    dir = await newStateDir();
    engine = new FakeEngine();
    store = new BaselineStore(dir, clock);
    deps = makeDeps(dir, engine);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a View-scoped baseline from the whole view, summing each day, and refuses a second one', async () => {
    engine.dailyCosts = () => [
      { date: '2026-03-01', group_name: 'EC2', cost: 10 },
      { date: '2026-03-01', group_name: 'S3', cost: 5 },
      { date: '2026-02-28', group_name: 'EC2', cost: 20n },
    ];

    const created = await store.create(deps, { scope: { kind: 'view', viewId: 'v-1' }, name: 'Finance view' });

    expect(created.scopeLabel).toBe('View: v-1');
    expect(created.spec.name).toBe('Finance view');
    // No filters: the only bound values are the lookback window's bounds.
    expect(engine.callsOf('dailyCosts').map(c => c.params)).toEqual([[LOOKBACK_START, QUERY_END]]);
    const detail = await store.getDetail(deps, created.spec.id);
    expect(detail?.dailyHistory).toEqual([{ date: '2026-02-28', cost: 20 }, { date: '2026-03-01', cost: 15 }]);
    await expect(store.create(deps, { scope: { kind: 'view', viewId: 'v-1' } })).rejects.toThrow('A baseline for this scope already exists.');
  });

  it('treats a scope listing the same values in another order as the same scope', async () => {
    await store.create(deps, { scope: filterScope({ service: ['S3', 'EC2'] }) });
    await expect(store.create(deps, { scope: filterScope({ service: ['EC2', 'S3'] }) })).rejects.toThrow('already exists');

    await store.create(deps, { scope: filterScope({ account_id: ['111', '111'] }) });
    await expect(store.create(deps, { scope: filterScope({ account_id: ['111', '111'] }) })).rejects.toThrow('already exists');
  });

  it('labels a filter scope with no dimensions "All" and queries it grouped by service', async () => {
    const created = await store.create(deps, { scope: { kind: 'filter', filters: {} } });

    expect(created.scopeLabel).toBe('All');
    expect(engine.callsOf('dailyCosts')[0]?.sql).toContain('AS group_name');
    expect(engine.callsOf('dailyCosts')[0]?.params).toEqual([LOOKBACK_START, QUERY_END]);
  });

  it('logs nothing for a rename or a no-op band reset, and logs a bare note verbatim', async () => {
    const created = await store.create(deps, { scope: filterScope({ service: ['EC2'] }) });
    const id = created.spec.id;

    const renamed = await store.update(deps, id, { name: 'Compute' });
    expect(renamed?.spec.name).toBe('Compute');
    expect(renamed?.triage.notes).toEqual([]);

    const unchanged = await store.update(deps, id, { manualBand: null });
    expect(unchanged?.triage.notes).toEqual([]);
    expect(unchanged?.spec.name).toBe('Compute');

    const noted = await store.update(deps, id, { note: { text: 'checked with finance' } });
    expect(noted?.triage.notes).toHaveLength(1);
    expect(noted?.triage.notes[0]).toEqual({ at: expect.any(String), text: 'checked with finance' });
  });

  it('re-snapshots the cost basis to the active Cost Scope on request, and notes it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-04T12:00:00.000Z') });
    const created = await store.create(deps, { scope: filterScope({ service: ['EC2'] }) });
    const marketplaceAttribution = { enabled: false, rules: [] };
    const switched = makeDeps(dir, engine, { getCostScope: () => Promise.resolve({ costMetric: 'effective', rules: [], marketplaceAttribution }) });
    vi.setSystemTime(new Date('2026-03-05T08:00:00.000Z'));

    const updated = await store.update(switched, created.spec.id, { resnapshotBasis: true });

    expect(created.spec.basisSnapshotAt).toBe('2026-03-04T12:00:00.000Z');
    expect(updated?.spec.basisSnapshotAt).toBe('2026-03-05T08:00:00.000Z');
    expect(updated?.spec.basis).toEqual({ costMetric: 'effective', rules: [], marketplaceAttribution });
    expect(updated?.triage.notes.map(n => n.text)).toEqual(['re-snapshotted cost basis']);
  });

  it('recomputes a single baseline on request and ignores an unknown id', async () => {
    const created = await store.create(deps, { scope: filterScope({ service: ['EC2'] }) });
    const statuses: BaselineRecomputeStatus[] = [];
    store.onStatusChanged(s => { statuses.push(s); });
    const before = engine.callsOf('dailyCosts').length;

    await store.recompute(deps, { only: 'no-such-baseline' });
    expect(engine.callsOf('dailyCosts')).toHaveLength(before);
    expect(store.getStatus().state).toBe('idle');

    await store.recompute(deps, { only: created.spec.id });
    expect(engine.callsOf('dailyCosts')).toHaveLength(before + 1);
    expect(statuses).toContainEqual({ state: 'running', phase: 'computing', done: 0, total: 1 });
    expect(store.getStatus().state).toBe('idle');
  });

  it('reports a recompute that fails with a non-Error by its text', async () => {
    const failing = makeDeps(dir, engine, {
      getQueryDimensions: vi.fn<() => Promise<DimensionsConfig>>().mockRejectedValue('dimensions offline'),
    });

    await store.recompute(failing);

    expect(store.getStatus()).toEqual({ state: 'error', message: 'dimensions offline', lastRun: null });
  });
});

describe('BaselineStore — discovery', () => {
  let dir = '';
  let engine: FakeEngine;

  beforeEach(async () => {
    dir = await newStateDir();
    engine = new FakeEngine();
  });

  it('skips discovery without a provider, leaving each baseline without history', async () => {
    await writeState(dir, {
      baselines: [svcSpec('manual', 'EC2'), { ...svcSpec('found', 'S3'), source: 'discovered' }],
    });
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine, { getQueryProviders: () => Promise.resolve([]) });

    await store.recompute(deps);

    expect(engine.calls).toEqual([]);
    expect(store.getStatus().state).toBe('idle');
    const { items } = await store.list(deps, {});
    expect(ids(items).sort()).toEqual(['found', 'manual']);
    for (const r of items) expect(r.status).toBe('insufficient-data');
    await expect(store.getSnapshots(deps, 'manual')).resolves.toEqual([]);
  });

  it('skips discovery when no synced month falls inside the lookback', async () => {
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine, { getQueryProviders: () => Promise.resolve([{ name: PROVIDER, type: 'aws', availablePeriods: ['2020-01'] }]) });
    const created = await store.create(deps, { scope: filterScope({ service: ['EC2'] }) });

    await store.recompute(deps);

    expect(engine.calls).toEqual([]);
    expect((await store.getDetail(deps, created.spec.id))?.dailyHistory).toEqual([]);
  });

  it('discovers nothing when no built-in dimension is enabled', async () => {
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine, { getQueryDimensions: () => Promise.resolve({ builtIn: [], tags: [{ tagName: 'team', label: 'Team' }] }) });

    await store.recompute(deps);

    expect(engine.callsOf('probe')).toHaveLength(1);
    expect(engine.callsOf('totals')).toEqual([]);
    expect((await store.list(deps, {})).total).toBe(0);
  });

  it('falls back to every enabled built-in when the cardinality probe fails or comes back empty', async () => {
    engine.totals = [{ account_id: '111', service: 'EC2', total: 5000 }];

    for (const cardinality of [{ reject: 'probe timed out' }, { rows: [] }] satisfies Answer[]) {
      engine.cardinality = cardinality;
      const stateDir = await newStateDir();
      const store = new BaselineStore(stateDir, clock);
      const deps = makeDeps(stateDir, engine);

      await store.recompute(deps);

      const [record] = (await store.list(deps, {})).items;
      expect(record?.spec.source).toBe('discovered');
      expect(filterValues(record?.spec.scope ?? { kind: 'filter', filters: {} })).toEqual({ account_id: ['111'], service: ['EC2'] });
    }
    expect(engine.callsOf('totals').every(c => c.sql.includes('AS account_id') && c.sql.includes('AS service'))).toBe(true);
  });

  it('never mints a discovered duplicate of a manually pinned scope, and refreshes the manual one too', async () => {
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine);
    const manual = await store.create(deps, { scope: filterScope({ service: ['EC2'], account_id: ['111'] }) });
    engine.totals = [
      { account_id: '111', service: 'EC2', total: 5000 },
      { account_id: '222', service: 'S3', total: 9000 },
    ];
    const queriesBefore = engine.callsOf('dailyCosts').length;

    await store.recompute(deps);

    const { items } = await store.list(deps, {});
    expect(items).toHaveLength(2);
    const discovered = items.filter(r => r.spec.source === 'discovered');
    expect(discovered.map(r => filterValues(r.spec.scope))).toEqual([{ account_id: ['222'], service: ['S3'] }]);
    expect(recordOf(items, manual.spec.id).spec.source).toBe('manual');
    expect(engine.callsOf('dailyCosts')).toHaveLength(queriesBefore + 1);
  });

  it('defaults the lag to two days and carries marketplace attribution into discovered baselines', async () => {
    const marketplaceAttribution = { enabled: true, rules: [] };
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine, { getCostScope: () => Promise.resolve({ costMetric: 'billed', rules: [], marketplaceAttribution }) });
    engine.totals = [{ account_id: '111', service: 'EC2', total: 5000 }];

    await store.recompute(deps);

    expect(engine.callsOf('totals')[0]?.params).toEqual([LOOKBACK_START, QUERY_END]);
    const [record] = (await store.list(deps, {})).items;
    expect(record?.spec.basis).toEqual({ costMetric: 'billed', rules: [], marketplaceAttribution });
  });

  it('throttles computing progress to about a hundred updates however many baselines there are', async () => {
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine, {
      getQueryDimensions: () => Promise.resolve({ builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }], tags: [] }),
    });
    engine.totals = Array.from({ length: 201 }, (_, i) => ({ service: `svc-${String(i)}`, total: 5000 }));
    const computing: { done: number; total: number }[] = [];
    store.onStatusChanged(s => {
      if (s.state === 'running' && s.phase === 'computing') computing.push({ done: s.done, total: s.total });
    });

    await store.recompute(deps);

    // One update per two baselines (step = 201 / 100), plus the final one.
    expect(computing[0]).toEqual({ done: 0, total: 201 });
    expect(computing).toHaveLength(1 + 100 + 1);
    expect(computing.at(-1)).toEqual({ done: 201, total: 201 });
    expect((await store.list(deps, {})).total).toBe(201);
  });

  it('starting fresh re-mints discovered baselines but keeps manual ones', async () => {
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine);
    const manual = await store.create(deps, { scope: filterScope({ service: ['Support'] }) });
    engine.totals = [{ account_id: '111', service: 'EC2', total: 5000 }];
    await store.recompute(deps);
    const discoveredBefore = (await store.list(deps, {})).items.find(r => r.spec.source === 'discovered');
    if (discoveredBefore === undefined) throw new Error('expected a discovered baseline');
    await store.update(deps, discoveredBefore.spec.id, { name: 'Edited by the user' });

    await store.recompute(deps, { startFresh: true });

    const { items } = await store.list(deps, {});
    expect(items.map(r => r.spec.source).sort()).toEqual(['discovered', 'manual']);
    expect(recordOf(items, manual.spec.id).spec.source).toBe('manual');
    const discoveredAfter = items.find(r => r.spec.source === 'discovered');
    expect(discoveredAfter?.spec.id).not.toBe(discoveredBefore.spec.id);
    expect(discoveredAfter?.spec.name).toBeUndefined();
  });

  it('ignores a dimension a filter scope leaves unset', async () => {
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine);
    const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
    filters[asDimensionId('service')] = [asTagValue('EC2')];
    filters[asDimensionId('account_id')] = undefined;

    const created = await store.create(deps, { scope: { kind: 'filter', filters } });

    expect(created.scopeLabel).toBe('EC2');
    await expect(store.create(deps, { scope: filterScope({ service: ['EC2'] }) })).rejects.toThrow('already exists');
  });

  it('stops recomputing a baseline the user deletes mid-run', async () => {
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine);
    const first = await store.create(deps, { scope: filterScope({ service: ['svc-a'] }) });
    const second = await store.create(deps, { scope: filterScope({ service: ['svc-b'] }) });
    engine.dailyCosts = async (params) => {
      if (params.includes('svc-a')) await store.delete(deps, second.spec.id);
      return [];
    };
    const queriesForSecond = (): number => engine.callsOf('dailyCosts').filter(c => c.params.includes('svc-b')).length;
    const before = queriesForSecond();

    await store.recompute(deps);

    expect(queriesForSecond()).toBe(before);
    expect(ids((await store.list(deps, {})).items)).toEqual([first.spec.id]);
    await expect(store.getDetail(deps, second.spec.id)).resolves.toBeNull();
  });
});

describe('BaselineStore — rollup routing', () => {
  const ORG_ACCOUNTS = JSON.stringify({ accounts: [{ id: '111', ouPath: 'Engineering', tags: {} }] });
  const ROLLUP = "read_parquet(['/data/aws-main/rollup/daily-2026-03/rollup.parquet'])";
  const signatureFor = (orgJson: string): string =>
    computeShapeSignature({ providerType: 'aws', dimensions: DIMS, costMetric: 'billed', rules: [], orgAccountsDigest: computeOrgAccountsDigest(orgJson) });

  it('routes discovery and drift through the rollup built for the same basis and org accounts', async () => {
    const dir = await newStateDir();
    await writeFile(join(dir, 'org-accounts.json'), ORG_ACCOUNTS);
    const engine = new FakeEngine();
    engine.totals = [{ account_id: '111', service: 'EC2', total: 5000 }];
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine, { rollupStore: { getBuiltSignature: () => signatureFor(ORG_ACCOUNTS), resolveSource: () => ROLLUP } });

    await store.recompute(deps);

    expect(engine.callsOf('probe').map(c => c.materialized)).toEqual([false]);
    for (const c of [...engine.callsOf('totals'), ...engine.callsOf('discovery')]) {
      expect(c.materialized).toBe(true);
      expect(c.sql).toContain(ROLLUP);
    }

    const [record] = (await store.list(deps, {})).items;
    if (record === undefined) throw new Error('expected one discovered baseline');
    await store.getDrift(deps, record.spec.id, 'account_id');
    expect(engine.callsOf('dailyCosts').map(c => c.materialized)).toEqual([true, true]);
  });

  it('reads raw data when the rollup was built for a different org-accounts list', async () => {
    const dir = await newStateDir();
    await writeFile(join(dir, 'org-accounts.json'), ORG_ACCOUNTS);
    const engine = new FakeEngine();
    engine.totals = [{ account_id: '111', service: 'EC2', total: 5000 }];
    const store = new BaselineStore(dir, clock);
    // Built before any org sync: the digest of the absent file.
    const deps = makeDeps(dir, engine, { rollupStore: { getBuiltSignature: () => signatureFor(''), resolveSource: () => ROLLUP } });

    await store.recompute(deps);

    expect(engine.callsOf('totals').map(c => c.materialized)).toEqual([false]);
    expect(engine.callsOf('totals')[0]?.sql).not.toContain(ROLLUP);
  });

  it('reads raw data for a multi-provider estate, since the rollup holds only the first provider', async () => {
    const dir = await newStateDir();
    const engine = new FakeEngine();
    engine.totals = [{ account_id: '111', service: 'EC2', total: 5000 }];
    const store = new BaselineStore(dir, clock);
    const deps = makeDeps(dir, engine, {
      getQueryProviders: () => Promise.resolve([...SYNCED, { name: asProviderName('aws-second'), type: 'aws', availablePeriods: ['2026-02'] }]),
      rollupStore: { getBuiltSignature: () => signatureFor(''), resolveSource: () => ROLLUP },
    });

    await store.recompute(deps);

    expect(engine.callsOf('totals').map(c => c.materialized)).toEqual([false]);
  });
});

describe('BaselineStore — getDrift', () => {
  it('returns no drift rows without a provider or without synced data in the window', async () => {
    const dir = await newStateDir();
    const engine = new FakeEngine();
    const store = new BaselineStore(dir, clock);
    const created = await store.create(makeDeps(dir, engine), { scope: filterScope({ service: ['EC2'] }) });
    const before = engine.calls.length;

    const noProvider = makeDeps(dir, engine, { getQueryProviders: () => Promise.resolve([]) });
    await expect(store.getDrift(noProvider, created.spec.id, 'account_id')).resolves.toEqual([]);
    const stale = makeDeps(dir, engine, { getQueryProviders: () => Promise.resolve([{ name: PROVIDER, type: 'aws', availablePeriods: ['2020-01'] }]) });
    await expect(store.getDrift(stale, created.spec.id, 'account_id')).resolves.toEqual([]);
    expect(engine.calls).toHaveLength(before);
  });

  it('shows a child that spent only in the band window as a full drop, under the default lag', async () => {
    const dir = await newStateDir();
    const engine = new FakeEngine();
    engine.dailyCosts = (params) => (params.includes(TRAILING_START)
      ? [{ date: '2026-03-01', group_name: '111', cost: 300 }]
      : [{ date: '2026-01-15', group_name: '111', cost: 3650 }, { date: '2025-06-01', group_name: '222', cost: 730 }]);
    const store = new BaselineStore(dir, clock);
    // A basis snapshotted from a scope with no explicit lag falls back to two days.
    const deps = makeDeps(dir, engine, { getCostScope: () => Promise.resolve({ costMetric: 'billed', rules: [] }) });
    const created = await store.create(deps, { scope: filterScope({ service: ['EC2'] }) });
    expect('lagDays' in created.spec.basis).toBe(false);

    const drift = await store.getDrift(deps, created.spec.id, 'account_id');

    expect(drift).toEqual([
      { child: '222', bandWindowCost: 2, currentCost: 0, delta: -2 },
      { child: '111', bandWindowCost: 10, currentCost: 10, delta: 0 },
    ]);
    expect(engine.callsOf('dailyCosts').slice(-2).map(c => c.params.filter(p => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p))))
      .toEqual([[TRAILING_START, QUERY_END], [BAND_START, QUERY_END]]);
  });
});

describe('BaselineStore — config file', () => {
  it('keeps an explicitly saved config even when it matches the defaults', async () => {
    const dir = await newStateDir();
    const store = new BaselineStore(dir, clock);
    const config: BaselinesDiscoveryConfig = store.effectiveConfig();

    await expect(store.setConfig(config)).resolves.toEqual({ config, isCustom: true });
    await expect(store.resetConfig()).resolves.toEqual({ config, isCustom: false });
  });
});
