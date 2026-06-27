import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  asDateString,
  asDimensionId,
  asDollars,
  asTagValue,
  buildBaselineDiscoveryQuery,
  buildDailyCostsQuery,
  buildDimCardinalityQuery,
  computeBands,
  computeCurrent,
  computeOrgAccountsDigest,
  computeSavings,
  computeShapeSignature,
  deriveStatus,
  effectiveBands,
  estimateBytesPerRow,
  getAncestorPath,
  logger,
  resolveDiscoveryGrain,
  validateBaselines,
} from '@costgoblin/core';
import type {
  BaselineCostBasis,
  BaselineCreateInput,
  BaselineDailyPoint,
  BaselineDetail,
  BaselineDriftRow,
  BaselineNote,
  BaselineRecomputeStatus,
  BaselineRecord,
  BaselineScope,
  BaselineSnapshot,
  BaselineSpec,
  BaselineStatus,
  BaselineTriage,
  BaselineUpdatePatch,
  BaselinesConfigState,
  BaselinesDiscoveryConfig,
  BaselinesListParams,
  BaselinesListResult,
  CostScopeConfig,
  DimensionId,
  DimensionsConfig,
  EntityRef,
  FilterMap,
  ManualBand,
  OrgNode,
  TagValue,
} from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';
import { resolveAvailablePeriods } from './handlers/query-utils.js';

/** The query/config capabilities the store needs to recompute. Mirrors the
 *  pieces the cost-query handlers pull off AppContext, kept structural so the
 *  store doesn't import the whole AppContext (avoids a cycle). */
export interface BaselineEngineDeps {
  readonly dataDir: string;
  readonly getQueryDimensions: () => Promise<DimensionsConfig>;
  readonly getCostScope: () => Promise<CostScopeConfig>;
  readonly getAccountMap: () => Promise<Map<string, string>>;
  readonly getAccountReverseMap: () => Promise<Map<string, readonly string[]>>;
  readonly getOrgTreeConfig: () => Promise<{ readonly tree: readonly OrgNode[] }>;
  readonly getAvailableColumns: (tier: 'daily' | 'hourly') => Promise<ReadonlySet<string>>;
  readonly runPreparedQuery: (sql: string, params: readonly unknown[], materialized?: boolean) => Promise<RawRow[]>;
  readonly rollupStore: {
    getBuiltSignature(): string | null;
    resolveSource(args: { requiredPeriods: readonly string[]; tier: 'daily' | 'hourly'; neededColumns: readonly string[] }): string | undefined;
  };
}

const HISTORY_WINDOW_DAYS = 365;
const MAX_SNAPSHOTS = 365;
const MAX_DISCOVERED = 500;

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function defaultConfig(): BaselinesDiscoveryConfig {
  return {
    lookbackDays: envNum('COSTGOBLIN_BASELINES_LOOKBACK_DAYS', 365),
    windowDays: envNum('COSTGOBLIN_BASELINES_WINDOW_DAYS', 30),
    lowerPct: envNum('COSTGOBLIN_BASELINES_LOWER_PCT', 10),
    upperPct: envNum('COSTGOBLIN_BASELINES_UPPER_PCT', 90),
    minMonthlyCost: asDollars(envNum('COSTGOBLIN_BASELINES_MIN_MONTHLY_COST', 100)),
    minSavings: asDollars(envNum('COSTGOBLIN_BASELINES_MIN_SAVINGS', 0)),
    reopenPct: envNum('COSTGOBLIN_BASELINES_REOPEN_PCT', 15),
    grainDimensions: [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Canonical identity for a scope — discovered baselines are unique per tuple. */
function scopeKey(scope: BaselineScope): string {
  if (scope.kind === 'view') return `view:${scope.viewId}`;
  const parts: string[] = [];
  for (const [dim, vals] of Object.entries(scope.filters)) {
    if (vals === undefined) continue;
    parts.push(`${dim}=${[...vals].map(String).sort().join('|')}`);
  }
  return `filter:${parts.sort().join('&')}`;
}

function scopeFilters(scope: BaselineScope): FilterMap {
  return scope.kind === 'filter' ? scope.filters : {};
}

function dateNDaysAgo(end: string, days: number): string {
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export class BaselineStore {
  private readonly dataDir: string;
  private readonly specs = new Map<string, BaselineSpec>();
  private readonly histories = new Map<string, readonly BaselineDailyPoint[]>();
  private readonly snapshots = new Map<string, readonly BaselineSnapshot[]>();
  private readonly triages = new Map<string, BaselineTriage>();
  private readonly bestAchieved = new Map<string, number>();
  private readonly statusOverrides = new Map<string, BaselineStatus>();
  private userConfig: BaselinesDiscoveryConfig | null = null;
  private status: BaselineRecomputeStatus = { state: 'idle', lastRun: null };
  private readonly listeners = new Set<(s: BaselineRecomputeStatus) => void>();
  private loaded = false;
  private recomputing = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  // --- persistence ------------------------------------------------------------

  private specsPath(): string { return join(dirname(this.dataDir), 'baselines.json'); }
  private dataPath(): string { return join(dirname(this.dataDir), 'baselines-data.json'); }

  async load(deps: BaselineEngineDeps): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.loadSpecs(deps);
    await this.loadData();
    await this.primeOrgDigest(deps);
  }

  private async loadSpecs(deps: BaselineEngineDeps): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.specsPath(), 'utf-8')); } catch { return; }
    if (!isRecord(raw)) return;
    if (isRecord(raw['config'])) this.userConfig = parseConfig(raw['config']);
    const dimensions = await deps.getQueryDimensions();
    if (Array.isArray(raw['baselines'])) {
      try {
        const specs = validateBaselines({ baselines: raw['baselines'] }, dimensions);
        for (const s of specs) this.specs.set(s.id, s);
      } catch (err: unknown) {
        logger.warn('baselines: failed to load specs', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (isRecord(raw['meta'])) {
      for (const [id, m] of Object.entries(raw['meta'])) {
        if (!isRecord(m)) continue;
        if (isRecord(m['triage'])) this.triages.set(id, parseTriage(m['triage']));
        if (typeof m['bestAchieved'] === 'number') this.bestAchieved.set(id, m['bestAchieved']);
        if (typeof m['statusOverride'] === 'string') {
          const s = m['statusOverride'];
          if (s === 'over' || s === 'under' || s === 'in-band' || s === 'insufficient-data') this.statusOverrides.set(id, s);
        }
      }
    }
  }

  private async loadData(): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.dataPath(), 'utf-8')); } catch { return; }
    if (!isRecord(raw)) return;
    if (isRecord(raw['history'])) {
      for (const [id, pts] of Object.entries(raw['history'])) {
        if (Array.isArray(pts)) this.histories.set(id, parsePoints(pts));
      }
    }
    if (isRecord(raw['snapshots'])) {
      for (const [id, snaps] of Object.entries(raw['snapshots'])) {
        if (Array.isArray(snaps)) this.snapshots.set(id, parseSnapshots(snaps));
      }
    }
  }

  private async save(): Promise<void> {
    const meta: Record<string, unknown> = {};
    for (const id of this.specs.keys()) {
      meta[id] = {
        triage: this.triages.get(id) ?? { notes: [] },
        bestAchieved: this.bestAchieved.get(id) ?? null,
        ...(this.statusOverrides.has(id) ? { statusOverride: this.statusOverrides.get(id) } : {}),
      };
    }
    const specsDoc = {
      version: 1,
      config: this.userConfig,
      baselines: [...this.specs.values()],
      meta,
    };
    const history: Record<string, unknown> = {};
    const snaps: Record<string, unknown> = {};
    for (const [id, pts] of this.histories) history[id] = pts;
    for (const [id, s] of this.snapshots) snaps[id] = s;
    const dataDoc = { version: 1, history, snapshots: snaps };
    await writeFile(this.specsPath(), JSON.stringify(specsDoc, null, 2));
    await writeFile(this.dataPath(), JSON.stringify(dataDoc, null, 2));
  }

  // --- status channel ---------------------------------------------------------

  onStatusChanged(listener: (s: BaselineRecomputeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  getStatus(): BaselineRecomputeStatus { return this.status; }

  private setStatus(status: BaselineRecomputeStatus): void {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  // --- config -----------------------------------------------------------------

  effectiveConfig(): BaselinesDiscoveryConfig { return this.userConfig ?? defaultConfig(); }

  getConfigState(): BaselinesConfigState {
    return { config: this.effectiveConfig(), isCustom: this.userConfig !== null };
  }

  async setConfig(config: BaselinesDiscoveryConfig): Promise<BaselinesConfigState> {
    this.userConfig = config;
    await this.save();
    return this.getConfigState();
  }

  async resetConfig(): Promise<BaselinesConfigState> {
    this.userConfig = null;
    await this.save();
    return this.getConfigState();
  }

  // --- record derivation ------------------------------------------------------

  private deriveRecord(spec: BaselineSpec, accountMap: Map<string, string>, orgTree: readonly OrgNode[]): BaselineRecord {
    const cfg = this.effectiveConfig();
    const history = this.histories.get(spec.id) ?? [];
    const costs = history.map((p) => p.cost);
    const bands = computeBands(history, { lowerPct: cfg.lowerPct, upperPct: cfg.upperPct });
    const current = computeCurrent(history, cfg.windowDays);
    const eff = effectiveBands(bands, spec.manualBand, costs);
    const savings = computeSavings(current, eff);
    const derived = deriveStatus(current, eff, history.length, { minDataPoints: 30, subCentFloor: 0.01, overPctOverLower: 0 });
    const status = this.statusOverrides.get(spec.id) ?? derived;
    const currentDaily = current?.avgDaily ?? asDollars(0);
    const { ownerPath, scopeLabel } = describeScope(spec.scope, accountMap, orgTree);
    return {
      spec,
      stats: history.length > 0 ? { calculatedAt: spec.updatedAt, dataPoints: history.length, bands } : null,
      current,
      savings,
      status,
      effectiveLower: eff.lower,
      effectiveUpper: eff.upper,
      currentDaily,
      potentialDaily: savings.potentialDaily,
      realizedDaily: savings.realizedDaily,
      bestAchieved: this.bestAchieved.has(spec.id) ? asDollars(this.bestAchieved.get(spec.id) ?? 0) : null,
      ...(ownerPath === undefined ? {} : { ownerPath }),
      scopeLabel,
      triage: this.triages.get(spec.id) ?? { notes: [] },
    };
  }

  // --- queries (list / get) ---------------------------------------------------

  async list(deps: BaselineEngineDeps, params: BaselinesListParams): Promise<BaselinesListResult> {
    await this.load(deps);
    const accountMap = await deps.getAccountMap();
    const orgTree = (await deps.getOrgTreeConfig()).tree;
    let records = [...this.specs.values()].map((s) => this.deriveRecord(s, accountMap, orgTree));

    if (params.status !== undefined) {
      const actionable: ReadonlySet<BaselineStatus> = new Set<BaselineStatus>(['over', 'under']);
      records = params.status === 'actionable'
        ? records.filter((r) => actionable.has(r.status))
        : records.filter((r) => r.status === params.status);
    }
    if (params.owner !== undefined) {
      records = records.filter((r) => (r.ownerPath ?? []).some((n) => String(n) === params.owner));
    }
    if (params.dimension !== undefined) {
      records = records.filter((r) => r.spec.scope.kind === 'filter' && params.dimension !== undefined && params.dimension in r.spec.scope.filters);
    }

    const dir = params.sortDir ?? 'desc';
    const key = params.sortBy ?? 'potential';
    records.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return dir === 'asc' ? cmp : -cmp;
    });

    const partition = records.filter((r) => r.spec.source === 'discovered');
    const totalPotentialMonthly = asDollars(partition.reduce((s, r) => s + r.savings.potentialMonthly, 0));
    const totalRealizedMonthly = asDollars(partition.reduce((s, r) => s + r.savings.realizedMonthly, 0));
    const total = records.length;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? records.length;
    return { items: records.slice(offset, offset + limit), totalPotentialMonthly, totalRealizedMonthly, total };
  }

  async getDetail(deps: BaselineEngineDeps, id: string): Promise<BaselineDetail | null> {
    await this.load(deps);
    const spec = this.specs.get(id);
    if (spec === undefined) return null;
    const accountMap = await deps.getAccountMap();
    const orgTree = (await deps.getOrgTreeConfig()).tree;
    return {
      record: this.deriveRecord(spec, accountMap, orgTree),
      dailyHistory: this.histories.get(id) ?? [],
      snapshots: this.snapshots.get(id) ?? [],
    };
  }

  async getSnapshots(deps: BaselineEngineDeps, id: string): Promise<readonly BaselineSnapshot[]> {
    await this.load(deps);
    return this.snapshots.get(id) ?? [];
  }

  // --- mutations --------------------------------------------------------------

  async create(deps: BaselineEngineDeps, input: BaselineCreateInput): Promise<BaselineRecord> {
    await this.load(deps);
    const key = scopeKey(input.scope);
    for (const s of this.specs.values()) {
      if (scopeKey(s.scope) === key) throw new Error('A baseline for this scope already exists.');
    }
    const basis = await snapshotBasis(deps);
    const now = new Date().toISOString();
    const spec: BaselineSpec = {
      id: randomUUID(),
      ...(input.name === undefined ? {} : { name: input.name }),
      source: 'manual',
      scope: input.scope,
      basis,
      basisSnapshotAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.specs.set(spec.id, spec);
    await this.recomputeOne(deps, spec);
    await this.save();
    const accountMap = await deps.getAccountMap();
    const orgTree = (await deps.getOrgTreeConfig()).tree;
    return this.deriveRecord(spec, accountMap, orgTree);
  }

  async update(deps: BaselineEngineDeps, id: string, patch: BaselineUpdatePatch): Promise<BaselineRecord | null> {
    await this.load(deps);
    const spec = this.specs.get(id);
    if (spec === undefined) return null;

    const accountMap = await deps.getAccountMap();
    const orgTree = (await deps.getOrgTreeConfig()).tree;
    const before = this.deriveRecord(spec, accountMap, orgTree);

    let manualBand: ManualBand | undefined = spec.manualBand;
    let bandChanged = false;
    if (patch.manualBand === null) { manualBand = undefined; bandChanged = spec.manualBand !== undefined; }
    else if (patch.manualBand !== undefined) { manualBand = patch.manualBand; bandChanged = true; }

    const basis = patch.resnapshotBasis === true ? await snapshotBasis(deps) : spec.basis;
    const name = patch.name ?? spec.name;
    // Rebuild from scratch so a cleared manualBand drops the key entirely
    // (exactOptionalPropertyTypes forbids an explicit `undefined`).
    const updated: BaselineSpec = {
      id: spec.id,
      ...(name === undefined ? {} : { name }),
      source: spec.source,
      scope: spec.scope,
      basis,
      basisSnapshotAt: patch.resnapshotBasis === true ? new Date().toISOString() : spec.basisSnapshotAt,
      ...(manualBand === undefined ? {} : { manualBand }),
      createdAt: spec.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.specs.set(id, updated);

    if (patch.status !== undefined) this.statusOverrides.set(id, patch.status);

    const after = this.deriveRecord(updated, accountMap, orgTree);
    const summary = changeSummary(before, after, bandChanged, patch);
    if (summary !== null || patch.note !== undefined) {
      const note: BaselineNote = {
        at: new Date().toISOString(),
        text: [summary, patch.note?.text].filter((t): t is string => t !== null && t !== undefined && t.length > 0).join(' — '),
        ...(patch.status !== undefined ? { statusChange: { from: before.status, to: patch.status } } : {}),
        ...(patch.note?.ticket === undefined ? {} : { ticket: patch.note.ticket }),
      };
      const triage = this.triages.get(id) ?? { notes: [] };
      this.triages.set(id, { notes: [...triage.notes, note] });
    }

    await this.save();
    return this.deriveRecord(updated, accountMap, orgTree);
  }

  async delete(deps: BaselineEngineDeps, id: string): Promise<void> {
    await this.load(deps);
    this.specs.delete(id);
    this.histories.delete(id);
    this.snapshots.delete(id);
    this.triages.delete(id);
    this.bestAchieved.delete(id);
    this.statusOverrides.delete(id);
    await this.save();
  }

  // --- recompute / discovery --------------------------------------------------

  async recompute(deps: BaselineEngineDeps, only?: string): Promise<void> {
    if (this.recomputing) return;
    this.recomputing = true;
    try {
      await this.load(deps);
      if (only !== undefined) {
        const spec = this.specs.get(only);
        if (spec !== undefined) {
          this.setStatus({ state: 'running', phase: 'computing', done: 0, total: 1 });
          await this.recomputeOne(deps, spec);
        }
      } else {
        this.setStatus({ state: 'running', phase: 'discovering', done: 0, total: 0 });
        await this.discover(deps);
        const specs = [...this.specs.values()];
        let done = 0;
        this.setStatus({ state: 'running', phase: 'computing', done, total: specs.length });
        for (const spec of specs) {
          // Discovered baselines already had their history set during discover();
          // only manual/view baselines need a per-baseline query here.
          if (spec.source === 'manual') await this.recomputeOne(deps, spec);
          else this.finalizeFromHistory(spec);
          done += 1;
          this.setStatus({ state: 'running', phase: 'computing', done, total: specs.length });
        }
      }
      await this.save();
      this.setStatus({ state: 'idle', lastRun: new Date().toISOString() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('baselines: recompute failed', { error: message });
      this.setStatus({ state: 'error', message, lastRun: this.status.state === 'idle' ? this.status.lastRun : null });
    } finally {
      this.recomputing = false;
    }
  }

  private async discover(deps: BaselineEngineDeps): Promise<void> {
    const cfg = this.effectiveConfig();
    const dimensions = await deps.getQueryDimensions();
    const costScope = await deps.getCostScope();
    const availableColumns = await deps.getAvailableColumns('daily');
    const end = dateNDaysAgo(todayUtc(), costScope.lagDays ?? 2);
    const start = dateNDaysAgo(end, cfg.lookbackDays);
    const dateRange = { start: asDateString(start), end: asDateString(end) };
    const { available, empty } = await resolveAvailablePeriods(deps.dataDir, 'daily', dateRange);
    if (empty) { logger.info('baselines: discovery skipped — no data in range'); return; }

    const opts = {
      dataDir: deps.dataDir,
      dimensions,
      availablePeriods: available,
      accountReverseMap: await deps.getAccountReverseMap(),
      costScope,
      availableColumns,
    };

    // 1) Probe cardinality of the enabled built-ins to drop high-card dims.
    const enabledFields = [...new Set(dimensions.builtIn.filter((d) => d.enabled !== false).map((d) => d.field))];
    const cardinalityByColumn: Record<string, number> = {};
    let lineItems = 0;
    try {
      const probe = buildDimCardinalityQuery(enabledFields, dateRange, opts);
      const probeRows = await deps.runPreparedQuery(probe.sql, probe.params, false);
      const row = probeRows[0];
      if (row !== undefined) {
        for (const f of enabledFields) cardinalityByColumn[f] = num(row[f]);
        lineItems = num(row['row_count']);
      }
    } catch (err: unknown) {
      logger.warn('baselines: cardinality probe failed; using empty grain guard', { error: err instanceof Error ? err.message : String(err) });
    }

    const grain = resolveDiscoveryGrain({
      dimensions,
      cardinalityByColumn,
      lineItems,
      bytesPerRow: estimateBytesPerRow(null),
      override: cfg.grainDimensions,
    });
    if (grain.length === 0) {
      logger.warn('baselines: no stable built-in dimensions for discovery grain');
      return;
    }

    // 2) Enumerate per-day series for every tuple above the threshold.
    const minTotalCost = cfg.minMonthlyCost * (cfg.lookbackDays / 30);
    const neededCols = [...grain.map((d) => d.field), 'cost'];
    const mat = this.matSource(deps, costScope, dimensions, availableColumns, dateRange, neededCols);
    const discovery = buildBaselineDiscoveryQuery(
      { dateRange, filters: {}, grainDimensionIds: grain.map((d) => d.name), minTotalCost },
      { ...opts, ...(mat === undefined ? {} : { materializedSource: mat }) },
    );
    const rows = await deps.runPreparedQuery(discovery.sql, discovery.params, mat !== undefined);

    // 3) Pivot into per-tuple histories.
    const byTuple = new Map<string, { values: Record<string, string>; points: BaselineDailyPoint[] }>();
    for (const r of rows) {
      const values: Record<string, string> = {};
      for (const d of grain) values[d.field] = str(r[d.field]);
      const tupleKey = grain.map((d) => `${d.name}=${values[d.field] ?? ''}`).sort().join('&');
      let entry = byTuple.get(tupleKey);
      if (entry === undefined) { entry = { values, points: [] }; byTuple.set(tupleKey, entry); }
      entry.points.push({ date: asDateString(str(r['date'])), cost: asDollars(num(r['cost'])) });
    }

    // 4) Upsert discovered baselines; cap to the largest tuples.
    const basis = await snapshotBasis(deps);
    const existingByScope = new Map<string, BaselineSpec>();
    for (const s of this.specs.values()) if (s.source === 'discovered') existingByScope.set(scopeKey(s.scope), s);

    const ranked = [...byTuple.values()]
      .map((e) => ({ ...e, total: e.points.reduce((s, p) => s + p.cost, 0) }))
      .sort((a, b) => b.total - a.total);
    if (ranked.length > MAX_DISCOVERED) {
      logger.warn('baselines: discovery capped', { found: ranked.length, kept: MAX_DISCOVERED });
    }
    const kept = ranked.slice(0, MAX_DISCOVERED);

    const seenScopes = new Set<string>();
    for (const tuple of kept) {
      const scope = buildScope(grain, tuple.values);
      const key = scopeKey(scope);
      seenScopes.add(key);
      const existing = existingByScope.get(key);
      const now = new Date().toISOString();
      const spec: BaselineSpec = existing !== undefined
        ? { ...existing, basis, basisSnapshotAt: now, updatedAt: now }
        : { id: randomUUID(), source: 'discovered', scope, basis, basisSnapshotAt: now, createdAt: now, updatedAt: now };
      this.specs.set(spec.id, spec);
      this.histories.set(spec.id, clampHistory(tuple.points, dateRange.end));
      this.finalizeFromHistory(spec);
    }

    // 5) Vanished discovered tuples: keep the spec but mark history empty so it
    //    shows insufficient-data rather than a stale band.
    for (const [key, spec] of existingByScope) {
      if (!seenScopes.has(key)) this.histories.set(spec.id, []);
    }
  }

  private async recomputeOne(deps: BaselineEngineDeps, spec: BaselineSpec): Promise<void> {
    const cfg = this.effectiveConfig();
    const dimensions = await deps.getQueryDimensions();
    const availableColumns = await deps.getAvailableColumns('daily');
    const end = dateNDaysAgo(todayUtc(), spec.basis.lagDays ?? 2);
    const start = dateNDaysAgo(end, cfg.lookbackDays);
    const dateRange = { start: asDateString(start), end: asDateString(end) };
    const { available, empty } = await resolveAvailablePeriods(deps.dataDir, 'daily', dateRange);
    if (empty) { this.histories.set(spec.id, []); this.finalizeFromHistory(spec); return; }
    const basisScope = basisToCostScope(spec.basis);
    const groupBy = primaryGroupBy(spec.scope);
    const mat = this.matSource(deps, basisScope, dimensions, availableColumns, dateRange, [columnFor(dimensions, String(groupBy)), 'cost']);
    const opts = {
      dataDir: deps.dataDir,
      dimensions,
      availablePeriods: available,
      accountReverseMap: await deps.getAccountReverseMap(),
      costScope: basisScope,
      availableColumns,
      ...(mat === undefined ? {} : { materializedSource: mat }),
    };
    const query = buildDailyCostsQuery(
      { dateRange, filters: scopeFilters(spec.scope), groupBy },
      opts,
    );
    const rows = await deps.runPreparedQuery(query.sql, query.params, mat !== undefined);
    const byDay = new Map<string, number>();
    for (const r of rows) byDay.set(str(r['date']).slice(0, 10), (byDay.get(str(r['date']).slice(0, 10)) ?? 0) + num(r['cost']));
    const points: BaselineDailyPoint[] = [...byDay.entries()].map(([date, cost]) => ({ date: asDateString(date), cost: asDollars(cost) }));
    this.histories.set(spec.id, clampHistory(points, dateRange.end));
    this.finalizeFromHistory(spec);
  }

  /** Compute current/bands/savings/status from stored history, append a
   *  snapshot, and update bestAchieved. */
  private finalizeFromHistory(spec: BaselineSpec): void {
    const cfg = this.effectiveConfig();
    const history = this.histories.get(spec.id) ?? [];
    const costs = history.map((p) => p.cost);
    const bands = computeBands(history, { lowerPct: cfg.lowerPct, upperPct: cfg.upperPct });
    const current = computeCurrent(history, cfg.windowDays);
    const eff = effectiveBands(bands, spec.manualBand, costs);
    const savings = computeSavings(current, eff);
    const status = deriveStatus(current, eff, history.length, { minDataPoints: 30, subCentFloor: 0.01, overPctOverLower: 0 });
    const curDaily = current?.avgDaily ?? 0;
    if (current !== null) {
      const prevBest = this.bestAchieved.get(spec.id);
      if (prevBest === undefined || curDaily < prevBest) this.bestAchieved.set(spec.id, curDaily);
    }
    const snap: BaselineSnapshot = {
      date: asDateString(todayUtc()),
      lower: eff.lower,
      upper: eff.upper,
      current: asDollars(curDaily),
      potential: savings.potentialDaily,
      realized: savings.realizedDaily,
      status,
    };
    const prev = this.snapshots.get(spec.id) ?? [];
    const trimmed = [...prev.filter((s) => s.date !== snap.date), snap].slice(-MAX_SNAPSHOTS);
    this.snapshots.set(spec.id, trimmed);
  }

  async getDrift(deps: BaselineEngineDeps, id: string, childDimension: string): Promise<readonly BaselineDriftRow[]> {
    await this.load(deps);
    const spec = this.specs.get(id);
    if (spec === undefined) return [];
    const cfg = this.effectiveConfig();
    const dimensions = await deps.getQueryDimensions();
    const availableColumns = await deps.getAvailableColumns('daily');
    const basisScope = basisToCostScope(spec.basis);
    const end = dateNDaysAgo(todayUtc(), spec.basis.lagDays ?? 2);
    const trailingStart = dateNDaysAgo(end, cfg.windowDays);
    const bandStart = dateNDaysAgo(end, cfg.lookbackDays);
    const child = asDimensionId(childDimension);
    const accountReverseMap = await deps.getAccountReverseMap();

    const windowByChild = async (winStart: string): Promise<Map<string, number>> => {
      const range = { start: asDateString(winStart), end: asDateString(end) };
      const { available, empty } = await resolveAvailablePeriods(deps.dataDir, 'daily', range);
      if (empty) return new Map<string, number>();
      const mat = this.matSource(deps, basisScope, dimensions, availableColumns, range, [columnFor(dimensions, childDimension), 'cost']);
      const q = buildDailyCostsQuery(
        { dateRange: range, filters: scopeFilters(spec.scope), groupBy: child },
        {
          dataDir: deps.dataDir, dimensions, availablePeriods: available, accountReverseMap,
          costScope: basisScope, availableColumns,
          ...(mat === undefined ? {} : { materializedSource: mat }),
        },
      );
      const rows = await deps.runPreparedQuery(q.sql, q.params, mat !== undefined);
      const totals = new Map<string, number>();
      for (const r of rows) totals.set(str(r['group_name']), (totals.get(str(r['group_name'])) ?? 0) + num(r['cost']));
      return totals;
    };

    const [trailing, band] = await Promise.all([windowByChild(trailingStart), windowByChild(bandStart)]);
    const trailingDays = cfg.windowDays;
    const bandDays = Math.max(1, cfg.lookbackDays);
    const children = new Set<string>([...trailing.keys(), ...band.keys()]);
    const out: BaselineDriftRow[] = [];
    for (const c of children) {
      const cur = (trailing.get(c) ?? 0) / trailingDays;
      const baseAvg = (band.get(c) ?? 0) / bandDays;
      out.push({ child: c, bandWindowCost: asDollars(baseAvg), currentCost: asDollars(cur), delta: asDollars(cur - baseAvg) });
    }
    out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return out;
  }

  // --- rollup signature guard -------------------------------------------------

  private matSource(
    deps: BaselineEngineDeps,
    costScope: CostScopeConfig,
    dimensions: DimensionsConfig,
    availableColumns: ReadonlySet<string>,
    dateRange: { start: string; end: string },
    neededColumns: readonly string[],
  ): string | undefined {
    // Only use the rollup when the requested cost basis matches what the rollup
    // was built for — otherwise the pre-aggregated cost column is wrong.
    const built = deps.rollupStore.getBuiltSignature();
    if (built === null) return undefined;
    const sig = computeShapeSignature({
      dimensions,
      costMetric: costScope.costMetric,
      costPerspective: costScope.costPerspective ?? 'gross',
      rules: costScope.rules,
      marketplaceAttribution: costScope.marketplaceAttribution,
      orgAccountsDigest: this.cachedOrgDigest,
      availableColumns: [...availableColumns],
    });
    if (sig !== built) return undefined;
    return deps.rollupStore.resolveSource({ requiredPeriods: periodsFor(dateRange), tier: 'daily', neededColumns });
  }

  private cachedOrgDigest = '';
  async primeOrgDigest(deps: BaselineEngineDeps): Promise<void> {
    try {
      const raw = await readFile(join(dirname(deps.dataDir), 'org-accounts.json'), 'utf-8');
      this.cachedOrgDigest = computeOrgAccountsDigest(raw);
    } catch { this.cachedOrgDigest = computeOrgAccountsDigest(''); }
  }
}

// --- module helpers -----------------------------------------------------------

function periodsFor(dateRange: { start: string; end: string }): string[] {
  const out: string[] = [];
  const start = new Date(`${dateRange.start}T00:00:00Z`);
  const end = new Date(`${dateRange.end}T00:00:00Z`);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= last.getTime()) {
    out.push(`${String(cursor.getUTCFullYear())}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function columnFor(dimensions: DimensionsConfig, dimId: string): string {
  const found = dimensions.builtIn.find((d) => String(d.name) === dimId);
  return found?.field ?? 'service';
}

function primaryGroupBy(scope: BaselineScope) {
  if (scope.kind === 'filter') {
    const keys = Object.keys(scope.filters);
    if (keys[0] !== undefined) return asDimensionId(keys[0]);
  }
  return asDimensionId('service');
}

function buildScope(grain: readonly { readonly name: DimensionId; readonly field: string }[], values: Record<string, string>): BaselineScope {
  const fm: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  for (const d of grain) fm[d.name] = [asTagValue(values[d.field] ?? '')];
  return { kind: 'filter', filters: fm };
}

function clampHistory(points: readonly BaselineDailyPoint[], end: string): readonly BaselineDailyPoint[] {
  const start = dateNDaysAgo(end, HISTORY_WINDOW_DAYS);
  return points
    .filter((p) => String(p.date) >= start && String(p.date) <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function snapshotBasis(deps: BaselineEngineDeps): Promise<BaselineCostBasis> {
  const cs = await deps.getCostScope();
  return {
    costMetric: cs.costMetric,
    costPerspective: cs.costPerspective ?? 'gross',
    rules: cs.rules,
    ...(cs.marketplaceAttribution === undefined ? {} : { marketplaceAttribution: cs.marketplaceAttribution }),
    ...(cs.lagDays === undefined ? {} : { lagDays: cs.lagDays }),
  };
}

function basisToCostScope(basis: BaselineCostBasis): CostScopeConfig {
  return {
    costMetric: basis.costMetric,
    costPerspective: basis.costPerspective,
    rules: basis.rules,
    ...(basis.marketplaceAttribution === undefined ? {} : { marketplaceAttribution: basis.marketplaceAttribution }),
    ...(basis.lagDays === undefined ? {} : { lagDays: basis.lagDays }),
  };
}

function describeScope(scope: BaselineScope, accountMap: Map<string, string>, orgTree: readonly OrgNode[]): { ownerPath?: readonly EntityRef[] | undefined; scopeLabel: string } {
  if (scope.kind === 'view') return { scopeLabel: `View: ${scope.viewId}` };
  const parts: string[] = [];
  let ownerPath: readonly EntityRef[] | undefined;
  for (const [dim, vals] of Object.entries(scope.filters)) {
    if (vals === undefined) continue;
    const labelVals = vals.map((v) => (dim === 'account' || dim === 'account_id' ? accountMap.get(String(v)) ?? String(v) : String(v)));
    parts.push(labelVals.join(', '));
    if ((dim === 'account' || dim === 'account_id') && labelVals[0] !== undefined) {
      ownerPath = getAncestorPath(orgTree, labelVals[0]);
    }
  }
  return { ...(ownerPath === undefined ? {} : { ownerPath }), scopeLabel: parts.join(' · ') || 'All' };
}

function sortValue(r: BaselineRecord, key: BaselinesListParams['sortBy']): number | string {
  switch (key) {
    case 'realized': return r.realizedDaily;
    case 'current': return r.currentDaily;
    case 'scope': return r.scopeLabel;
    case 'potential':
    default: return r.potentialDaily;
  }
}

function changeSummary(before: BaselineRecord, after: BaselineRecord, bandChanged: boolean, patch: BaselineUpdatePatch): string | null {
  const bits: string[] = [];
  if (bandChanged) bits.push(`band ${before.effectiveLower.toFixed(2)}–${before.effectiveUpper.toFixed(2)} → ${after.effectiveLower.toFixed(2)}–${after.effectiveUpper.toFixed(2)}`);
  if (patch.status !== undefined && patch.status !== before.status) bits.push(`status ${before.status} → ${patch.status}`);
  if (patch.resnapshotBasis === true) bits.push('re-snapshotted cost basis');
  return bits.length > 0 ? bits.join('; ') : null;
}

function parseConfig(raw: Record<string, unknown>): BaselinesDiscoveryConfig {
  const base = defaultConfig();
  const grain = Array.isArray(raw['grainDimensions'])
    ? raw['grainDimensions'].filter((v): v is string => typeof v === 'string').map((v) => asDimensionId(v))
    : base.grainDimensions;
  return {
    lookbackDays: num(raw['lookbackDays']) || base.lookbackDays,
    windowDays: num(raw['windowDays']) || base.windowDays,
    lowerPct: typeof raw['lowerPct'] === 'number' ? raw['lowerPct'] : base.lowerPct,
    upperPct: typeof raw['upperPct'] === 'number' ? raw['upperPct'] : base.upperPct,
    minMonthlyCost: asDollars(num(raw['minMonthlyCost'])),
    minSavings: asDollars(num(raw['minSavings'])),
    reopenPct: typeof raw['reopenPct'] === 'number' ? raw['reopenPct'] : base.reopenPct,
    grainDimensions: grain,
  };
}

function parsePoints(raw: readonly unknown[]): readonly BaselineDailyPoint[] {
  const out: BaselineDailyPoint[] = [];
  for (const p of raw) {
    if (!isRecord(p)) continue;
    out.push({ date: asDateString(str(p['date'])), cost: asDollars(num(p['cost'])) });
  }
  return out;
}

function parseSnapshots(raw: readonly unknown[]): readonly BaselineSnapshot[] {
  const out: BaselineSnapshot[] = [];
  for (const s of raw) {
    if (!isRecord(s)) continue;
    const status = str(s['status']);
    const st: BaselineStatus = status === 'over' || status === 'under' || status === 'in-band' ? status : 'insufficient-data';
    out.push({
      date: asDateString(str(s['date'])),
      lower: asDollars(num(s['lower'])),
      upper: asDollars(num(s['upper'])),
      current: asDollars(num(s['current'])),
      potential: asDollars(num(s['potential'])),
      realized: asDollars(num(s['realized'])),
      status: st,
    });
  }
  return out;
}

function parseTriage(raw: Record<string, unknown>): BaselineTriage {
  const notes: BaselineNote[] = [];
  if (Array.isArray(raw['notes'])) {
    for (const n of raw['notes']) {
      if (!isRecord(n)) continue;
      notes.push({
        at: str(n['at']),
        text: str(n['text']),
        ...(isRecord(n['statusChange']) ? { statusChange: parseStatusChange(n['statusChange']) } : {}),
        ...(typeof n['ticket'] === 'string' ? { ticket: n['ticket'] } : {}),
      });
    }
  }
  return { notes };
}

function parseStatusChange(raw: Record<string, unknown>): { from: BaselineStatus; to: BaselineStatus } {
  const norm = (v: unknown): BaselineStatus => {
    const s = str(v);
    return s === 'over' || s === 'under' || s === 'in-band' ? s : 'insufficient-data';
  };
  return { from: norm(raw['from']), to: norm(raw['to']) };
}
