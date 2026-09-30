import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asDateString,
  asDimensionId,
  asDollars,
  asTagValue,
  BASELINE_TRIAGE_STATUSES,
  OPEN_TRIAGE_STATUSES,
  buildBaselineDiscoveryQuery,
  buildBaselineTotalsQuery,
  buildDailyCostsQuery,
  buildDimCardinalityQuery,
  compareByDate,
  computeBands,
  computeCurrent,
  computeOrgAccountsDigest,
  computeSavings,
  computeShapeSignature,
  DEFAULT_LAG_DAYS,
  deriveStatus,
  effectiveBands,
  estimateBytesPerRow,
  getAncestorPath,
  logger,
  resolveDiscoveryGrain,
  runRateSeries,
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
  BaselineTriageStatus,
  BaselineUpdatePatch,
  BaselinesConfigState,
  BaselinesDiscoveryConfig,
  BaselinesListParams,
  BaselinesListResult,
  CostScopeConfig,
  DateRange,
  DimensionId,
  DimensionsConfig,
  EntityRef,
  FilterMap,
  ManualBand,
  OrgNode,
  ProviderName,
  ProviderSourceSpec,
  QueryContextOptions,
  TagValue,
} from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';
import { columnForDimension, providersWithoutDataForRange } from './handlers/query-utils.js';

/** The query/config capabilities the store needs to recompute. Mirrors the
 *  pieces the cost-query handlers pull off AppContext, kept structural so the
 *  store doesn't import the whole AppContext (avoids a cycle). */
export interface BaselineEngineDeps {
  readonly dataDir: string;
  readonly stateDir: string;
  /** First configured provider, or null while onboarding — queries are
   *  provider-scoped (#516 phase-2 single-provider semantics). */
  readonly getFirstProviderName: () => Promise<ProviderName | null>;
  readonly getQueryProviders: (tier: 'daily' | 'hourly') => Promise<readonly ProviderSourceSpec[]>;
  readonly getQueryDimensions: () => Promise<DimensionsConfig>;
  readonly getCostScope: () => Promise<CostScopeConfig>;
  readonly getAccountMap: () => Promise<Map<string, string>>;
  readonly getAccountReverseMap: () => Promise<Map<string, readonly string[]>>;
  readonly getOrgTreeConfig: () => Promise<{ readonly tree: readonly OrgNode[] }>;
  readonly runPreparedQuery: (sql: string, params: readonly unknown[], materialized?: boolean) => Promise<RawRow[]>;
  readonly rollupStore: {
    getBuiltSignature(): string | null;
    resolveSource(args: { requiredPeriods: readonly string[]; tier: 'daily' | 'hourly'; neededColumns: readonly string[] }): string | undefined;
  };
}

const HISTORY_WINDOW_DAYS = 365;
const MAX_SNAPSHOTS = 365;

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
  // DuckDB COUNT/aggregate columns come back as bigint — coerce them, else every
  // cardinality probe reads 0 and the high-cardinality grain guard is defeated.
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** UTF-16 code-unit order (what `<` and a bare `.sort()` compare), NOT
 *  localeCompare: scopeKey and tupleKeyFor build identities, and collation ties
 *  distinct strings (NFC vs NFD spellings) and varies with the runtime's ICU
 *  data, which would make a key depend on input order or on the machine. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Canonical identity for a scope — discovered baselines are unique per tuple. */
function scopeKey(scope: BaselineScope): string {
  if (scope.kind === 'view') return `view:${scope.viewId}`;
  const parts: string[] = [];
  for (const [dim, vals] of Object.entries(scope.filters)) {
    if (vals === undefined) continue;
    parts.push(`${dim}=${[...vals].map(String).sort(compareCodeUnits).join('|')}`);
  }
  return `filter:${[...parts].sort(compareCodeUnits).join('&')}`;
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

/** The day a recompute's windows end on: today minus the cost basis's lag. */
function settledEnd(lagDays: number | undefined): string {
  return dateNDaysAgo(todayUtc(), lagDays ?? DEFAULT_LAG_DAYS);
}

/** The window a recompute reads: `lookbackDays` back from the settled end. */
function lookbackRange(lagDays: number | undefined, lookbackDays: number): DateRange {
  const end = settledEnd(lagDays);
  return { start: asDateString(dateNDaysAgo(end, lookbackDays)), end: asDateString(end) };
}

/** How much of a window's cost data can be read. Only a query over data that
 *  is present can show a scope spent nothing: 'none' says nothing about any
 *  scope, and under 'partial' an empty result may just be a scope whose spend
 *  sits on a missing provider. Neither may read as empty history, which
 *  finalizeFromHistory answers by dropping the scope's snapshot trend.
 *  getQueryProviders maps an unreadable costgoblin.yaml to [], so a config
 *  that is briefly invalid reads as 'none' too. */
type DataCoverage =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly missing: readonly ProviderName[]; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: string };

function dataCoverage(providers: readonly ProviderSourceSpec[], dateRange: DateRange): DataCoverage {
  if (providers.length === 0) return { kind: 'none', reason: 'no billing provider is configured, or the configuration could not be read' };
  const span = `${String(dateRange.start)} to ${String(dateRange.end)}`;
  const missing = providersWithoutDataForRange(providers, dateRange).map((p) => p.name);
  if (missing.length === providers.length) return { kind: 'none', reason: `no billing data is synced locally for ${span}` };
  if (missing.length > 0) return { kind: 'partial', missing, reason: `no billing data is synced locally for ${missing.join(', ')} for ${span}` };
  return { kind: 'full' };
}

/** Whether two windows read the same providers, so a gap between them is a
 *  change in spend rather than one window missing a provider's data. */
function sameCoverage(a: DataCoverage, b: DataCoverage): boolean {
  if (a.kind === 'none' || b.kind === 'none') return false;
  const missingA = a.kind === 'partial' ? a.missing.join('\n') : '';
  const missingB = b.kind === 'partial' ? b.missing.join('\n') : '';
  return missingA === missingB;
}

/** The recompute failure for a no-data state — surfaced as the status message. */
function leftUnchanged(reason: string): Error {
  return new Error(`${reason} — baselines left unchanged`);
}

/** Everything a discovery run reads up front, once for the whole run. */
interface DiscoveryLookback {
  readonly cfg: BaselinesDiscoveryConfig;
  readonly costScope: CostScopeConfig;
  readonly dateRange: DateRange;
  readonly providers: readonly ProviderSourceSpec[];
  readonly coverage: DataCoverage;
}

/** A discovery run either reconciled the discovered set — `refreshed` holds the
 *  ids whose history it re-set — or was skipped without touching anything. */
type DiscoveryOutcome =
  | { readonly kind: 'ran'; readonly refreshed: ReadonlySet<string> }
  | { readonly kind: 'skipped'; readonly reason: string };

const NO_CARDINALITY_PROBE: { readonly cardinalityByColumn: Record<string, number>; readonly lineItems: number } = { cardinalityByColumn: {}, lineItems: 0 };

export class BaselineStore {
  private readonly stateDir: string;
  private readonly specs = new Map<string, BaselineSpec>();
  private readonly histories = new Map<string, readonly BaselineDailyPoint[]>();
  private readonly snapshots = new Map<string, readonly BaselineSnapshot[]>();
  private readonly triages = new Map<string, BaselineTriage>();
  private readonly bestAchieved = new Map<string, number>();
  private readonly triageStatuses = new Map<string, BaselineTriageStatus>();
  /** Baselines whose triage status the user set explicitly — discovery's
   *  auto-ignore must never overwrite these. */
  private readonly userTriaged = new Set<string>();
  private userConfig: BaselinesDiscoveryConfig | null = null;
  private status: BaselineRecomputeStatus = { state: 'idle', lastRun: null };
  private lastSuccessfulRun: string | null = null;
  private readonly listeners = new Set<(s: BaselineRecomputeStatus) => void>();
  private loaded = false;
  private recomputing = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  // --- persistence ------------------------------------------------------------

  private specsPath(): string { return join(this.stateDir, 'baselines.json'); }
  private dataPath(): string { return join(this.stateDir, 'baselines-data.json'); }

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
    if (Array.isArray(raw['baselines'])) this.ingestSpecEntries(raw['baselines'], dimensions);
    if (isRecord(raw['meta'])) this.ingestSpecMeta(raw['meta']);
  }

  /** Validate per-spec, not atomically — one bad spec (e.g. its scope
   *  references a since-renamed dimension) must not discard every other
   *  baseline, including user-triaged ones with notes/manual bands. */
  private ingestSpecEntries(entries: readonly unknown[], dimensions: DimensionsConfig): void {
    let dropped = 0;
    for (const entry of entries) {
      try {
        const [spec] = validateBaselines({ baselines: [entry] }, dimensions);
        if (spec !== undefined) this.specs.set(spec.id, spec);
      } catch { dropped += 1; }
    }
    if (dropped > 0) logger.warn('baselines: dropped invalid specs on load', { dropped });
  }

  private ingestSpecMeta(meta: Record<string, unknown>): void {
    for (const [id, m] of Object.entries(meta)) {
      if (!isRecord(m)) continue;
      if (isRecord(m['triage'])) this.triages.set(id, parseTriage(m['triage']));
      if (typeof m['bestAchieved'] === 'number') this.bestAchieved.set(id, m['bestAchieved']);
      if (typeof m['triageStatus'] === 'string') {
        const t = parseTriageStatus(m['triageStatus']);
        if (t !== null) this.triageStatuses.set(id, t);
      }
      if (m['userTriaged'] === true) this.userTriaged.add(id);
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
        ...(this.triageStatuses.has(id) ? { triageStatus: this.triageStatuses.get(id) } : {}),
        ...(this.userTriaged.has(id) ? { userTriaged: true } : {}),
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
    // Only persist history/snapshots for live specs — drop any orphaned by a
    // delete that raced a recompute, so they don't survive across restarts.
    for (const [id, pts] of this.histories) if (this.specs.has(id)) history[id] = pts;
    for (const [id, s] of this.snapshots) if (this.specs.has(id)) snaps[id] = s;
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
    // Band the amortized run-rate, not raw daily costs, so a periodic/spiky
    // charge can't set a phantom ceiling. current is on the same basis.
    const runRate = runRateSeries(history, cfg.windowDays);
    const runRateCosts = runRate.map((p) => p.cost);
    const bands = computeBands(runRate, { lowerPct: cfg.lowerPct, upperPct: cfg.upperPct });
    const current = computeCurrent(history, cfg.windowDays);
    const eff = effectiveBands(bands, spec.manualBand, runRateCosts);
    const savings = computeSavings(current, eff);
    const status = deriveStatus(current, eff, history.length, { minDataPoints: cfg.windowDays, subCentFloor: 0.01, overPctOverLower: 0 });
    const currentDaily = current?.avgDaily ?? asDollars(0);
    const { ownerPath, scopeLabel } = describeScope(spec.scope, accountMap, orgTree);
    return {
      spec,
      stats: history.length > 0 ? { calculatedAt: spec.updatedAt, dataPoints: history.length, bands } : null,
      current,
      savings,
      status,
      triageStatus: this.triageStatuses.get(spec.id) ?? 'new',
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

    // Per-chip counts over ALL records (independent of the active filter).
    const open: ReadonlySet<BaselineTriageStatus> = new Set<BaselineTriageStatus>(OPEN_TRIAGE_STATUSES);
    const counts: Record<BaselineTriageStatus | 'open' | 'all', number> = {
      all: records.length, open: 0, 'new': 0, tracking: 0, acting: 0, resolved: 0, dismissed: 0, ignored: 0,
    };
    for (const r of records) {
      counts[r.triageStatus] += 1;
      if (open.has(r.triageStatus)) counts.open += 1;
    }

    if (params.triage !== undefined) {
      records = params.triage === 'open'
        ? records.filter((r) => open.has(r.triageStatus))
        : records.filter((r) => r.triageStatus === params.triage);
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
    return { items: records.slice(offset, offset + limit), totalPotentialMonthly, totalRealizedMonthly, total, counts };
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
      windowDays: this.effectiveConfig().windowDays,
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
    try {
      // With no cost data readable yet it stays insufficient-data until the
      // next recompute that can read some — creating it must not fail.
      await this.recomputeOne(deps, spec);
    } catch (err: unknown) {
      // A failed query must not leave a phantom spec behind: it would block
      // the retry as a duplicate scope, and the next save would persist it.
      this.forget(spec.id);
      throw err;
    }
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

    const triageChanged = patch.triageStatus !== undefined && patch.triageStatus !== before.triageStatus;
    // Only pin against discovery's auto-ignore on a real change — re-confirming
    // the current status (a perceived no-op) must not permanently pin it.
    if (triageChanged) { this.triageStatuses.set(id, patch.triageStatus); this.userTriaged.add(id); }

    const after = this.deriveRecord(updated, accountMap, orgTree);
    const summary = changeSummary(before, after, bandChanged, patch);
    if (summary !== null || patch.note !== undefined) {
      const note: BaselineNote = {
        at: new Date().toISOString(),
        text: [summary, patch.note?.text].filter((t): t is string => t !== null && t !== undefined && t.length > 0).join(' — '),
        ...(triageChanged ? { statusChange: { from: before.triageStatus, to: patch.triageStatus } } : {}),
        ...(patch.note?.ticket === undefined ? {} : { ticket: patch.note.ticket }),
      };
      const triage = this.triages.get(id) ?? { notes: [] };
      this.triages.set(id, { notes: [...triage.notes, note] });
    }

    await this.save();
    return this.deriveRecord(updated, accountMap, orgTree);
  }

  /** Drop a baseline from every in-memory map (no persist — callers save). */
  private forget(id: string): void {
    this.specs.delete(id);
    this.histories.delete(id);
    this.snapshots.delete(id);
    this.triages.delete(id);
    this.bestAchieved.delete(id);
    this.triageStatuses.delete(id);
    this.userTriaged.delete(id);
  }

  /** Whether the user has invested in a discovered baseline (set a status, added
   *  a note, renamed it, or set a manual band) — such baselines are preserved
   *  across re-discovery; untouched ones are pruned when their tuple vanishes. */
  private isUserEdited(id: string): boolean {
    const spec = this.specs.get(id);
    return this.userTriaged.has(id)
      || (this.triages.get(id)?.notes.length ?? 0) > 0
      || spec?.name !== undefined
      || spec?.manualBand !== undefined;
  }

  async delete(deps: BaselineEngineDeps, id: string): Promise<void> {
    await this.load(deps);
    this.forget(id);
    await this.save();
  }

  // --- recompute / discovery --------------------------------------------------

  async recompute(deps: BaselineEngineDeps, opts: { readonly only?: string; readonly startFresh?: boolean } = {}): Promise<void> {
    if (this.recomputing) return;
    this.recomputing = true;
    try {
      await this.load(deps);
      if (opts.only !== undefined) {
        const spec = this.specs.get(opts.only);
        if (spec !== undefined) {
          this.setStatus({ state: 'running', phase: 'computing', done: 0, total: 1 });
          const unavailable = await this.recomputeOne(deps, spec);
          if (unavailable !== null) throw leftUnchanged(unavailable);
        }
      } else {
        await this.recomputeAll(deps, opts.startFresh === true);
      }
      await this.save();
      this.lastSuccessfulRun = new Date().toISOString();
      this.setStatus({ state: 'idle', lastRun: this.lastSuccessfulRun });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('baselines: recompute failed', { error: message });
      // Keep the last *successful* run time — `this.status` is already 'running'
      // here (which carries no lastRun), so reading it would always drop it.
      this.setStatus({ state: 'error', message, lastRun: this.lastSuccessfulRun });
    } finally {
      this.recomputing = false;
    }
  }

  /** Full recompute: rediscover the baseline set, then refresh every spec's
   *  history and derived stats, broadcasting throttled progress. A baseline is
   *  only ever rewritten from data this run actually read: one whose window
   *  can't be read is left exactly as it was, and a run whose discovery could
   *  not run and that refreshed nothing else fails with the reason instead of
   *  reporting success. */
  private async recomputeAll(deps: BaselineEngineDeps, startFresh: boolean): Promise<void> {
    this.setStatus({ state: 'running', phase: 'discovering', done: 0, total: 0 });
    const discovery = await this.discover(deps, await this.discoveryLookback(deps), startFresh);
    // Start fresh means "rediscover from a clean slate": when discovery could
    // not run, nothing was wiped and the request fails rather than half-apply.
    if (discovery.kind === 'skipped' && startFresh) throw leftUnchanged(discovery.reason);
    const specs = [...this.specs.values()];
    const total = specs.length;
    let done = 0;
    let refreshed = 0;
    this.setStatus({ state: 'running', phase: 'computing', done, total });
    // Throttle progress broadcasts: with thousands of baselines, one IPC
    // message per item would flood the renderer.
    const step = Math.max(1, Math.floor(total / 100));
    for (const { id } of specs) {
      // `specs` was snapshotted before the awaits below; skip any baseline
      // the user deleted mid-recompute so we don't re-populate its history,
      // and read the rest afresh so an edit made meanwhile (a manual band,
      // say) is what today's snapshot is computed with.
      const spec = this.specs.get(id);
      if (spec === undefined) continue;
      if (await this.refreshSpec(deps, spec, discovery)) refreshed += 1;
      done += 1;
      if (done % step === 0 || done === total) this.setStatus({ state: 'running', phase: 'computing', done, total });
    }
    // Discovery skipped and nothing else refreshed: memory is untouched, so
    // fail (nothing is saved) rather than report a run that did nothing.
    if (discovery.kind === 'skipped' && refreshed === 0) throw leftUnchanged(discovery.reason);
    if (refreshed < done) {
      logger.warn('baselines: some baselines left unchanged — no fresh data for them this run', {
        unchanged: done - refreshed,
        ...(discovery.kind === 'skipped' ? { discoverySkipped: discovery.reason } : {}),
      });
    }
  }

  /** Refresh one baseline from this run's data; false when it is left as it was. */
  private async refreshSpec(deps: BaselineEngineDeps, spec: BaselineSpec, discovery: DiscoveryOutcome): Promise<boolean> {
    if (spec.source === 'discovered' && spec.scope.kind === 'filter') {
      if (discovery.kind === 'ran' && discovery.refreshed.has(spec.id)) { this.finalizeFromHistory(spec); return true; }
      // Discovery didn't fetch this one's history (under the auto-ignore
      // threshold, its provider missing from the window, or discovery skipped),
      // so never snapshot its stale history. One the user invested in gets its
      // own query like a manual baseline; the rest wait for the next discovery.
      if (!this.isUserEdited(spec.id)) return false;
    }
    return (await this.recomputeOne(deps, spec)) === null;
  }

  /** Everything discovery reads up front — config, cost scope, window, providers
   *  and their coverage of it — so the whole run works from one snapshot. */
  private async discoveryLookback(deps: BaselineEngineDeps): Promise<DiscoveryLookback> {
    const cfg = this.effectiveConfig();
    const costScope = await deps.getCostScope();
    const dateRange = lookbackRange(costScope.lagDays, cfg.lookbackDays);
    const providers = await deps.getQueryProviders('daily');
    return { cfg, costScope, dateRange, providers, coverage: dataCoverage(providers, dateRange) };
  }

  /** Rediscover the baseline set over `lookback`. Skipped, touching nothing,
   *  when none of its data can be read or no grain resolves. Every await comes
   *  before the start-fresh wipe and the reconcile, so a query that fails (or
   *  that the renderer cancels) leaves every baseline as it was. */
  private async discover(deps: BaselineEngineDeps, lookback: DiscoveryLookback, startFresh: boolean): Promise<DiscoveryOutcome> {
    const { cfg, costScope, dateRange, providers, coverage } = lookback;
    if (coverage.kind === 'none') return { kind: 'skipped', reason: coverage.reason };
    const dimensions = await deps.getQueryDimensions();
    const opts = {
      dataDir: deps.dataDir,
      dimensions,
      providers,
      accountReverseMap: await deps.getAccountReverseMap(),
      costScope,
    };

    // 1) Probe cardinality of the enabled built-ins to drop high-card dims —
    //    only the automatic grain reads it; an override is used as is.
    const { cardinalityByColumn, lineItems } = cfg.grainDimensions.length > 0
      ? NO_CARDINALITY_PROBE
      : await this.probeDimCardinality(deps, dateRange, opts);

    const grain = resolveDiscoveryGrain({
      dimensions,
      cardinalityByColumn,
      lineItems,
      bytesPerRow: estimateBytesPerRow(null),
      override: cfg.grainDimensions,
    });
    if (grain.length === 0) return { kind: 'skipped', reason: 'no enabled built-in dimension is available for the discovery grain' };

    const grainIds = grain.map((d) => d.name);
    const grainCols = grain.map((d) => d.field);
    // Auto-ignore threshold over the whole window: minMonthlyCost scaled by the
    // lookback months. The daily query's minTotalCost is this same number
    // (clamped to >= 0 there); reconcileDiscovered compares the raw value.
    const minTotal = cfg.minMonthlyCost * Math.max(1, cfg.lookbackDays / 30);

    // Both discovery queries hit the same source/columns — resolve the rollup
    // once (computeShapeSignature isn't free).
    const mat = this.matSource(deps, providers.length, costScope, dimensions, dateRange, [...grainCols, 'cost']);

    // 2) Cheap totals query — ONE row per tuple. Enumerates every scope without
    //    the per-day fan-out, so "discover everything" stays fast even on a big
    //    estate.
    const totalsQ = buildBaselineTotalsQuery(
      { dateRange, filters: {}, grainDimensionIds: grainIds },
      { ...opts, ...(mat === undefined ? {} : { materializedSource: mat }) },
    );
    const totalsRows = await deps.runPreparedQuery(totalsQ.sql, totalsQ.params, mat !== undefined);
    const tuples = foldTotalsByTuple(totalsRows, grain);
    logger.info('baselines: discovered tuples', { count: tuples.size });

    // 3) Bounded per-day query — only for tuples worth tracking (>= the
    //    auto-ignore threshold). These are the baselines a user will actually
    //    look at; auto-ignored ones don't need stored history.
    const dailyQ = buildBaselineDiscoveryQuery(
      { dateRange, filters: {}, grainDimensionIds: grainIds, minTotalCost: Math.max(0, minTotal) },
      { ...opts, ...(mat === undefined ? {} : { materializedSource: mat }) },
    );
    const dailyRows = await deps.runPreparedQuery(dailyQ.sql, dailyQ.params, mat !== undefined);
    const dailyByTuple = foldDailyByTuple(dailyRows, grain);

    // ^ last await. From here the wipe and the reconcile index this.specs
    // synchronously, so baselines the user deleted mid-discovery stay gone.
    // Start fresh: wipe ALL discovered baselines (incl. user-edited) so the
    // new grain rediscovers from a clean slate. Manual baselines are kept.
    if (startFresh) {
      for (const s of this.specs.values()) if (s.source === 'discovered') this.forget(s.id);
    }
    // 4+5) Upsert a baseline per live tuple; prune or blank the vanished ones.
    // The basis is the cost scope the queries above ran with, not a re-read.
    const refreshed = this.reconcileDiscovered({
      tuples, grain, basis: costScopeToBasis(costScope), dailyByTuple, historyEnd: dateRange.end, minTotal,
      keepVanished: coverage.kind === 'partial',
    });
    return { kind: 'ran', refreshed };
  }

  /** Probe cardinality of the enabled built-ins (used to drop high-cardinality
   *  dims from the automatic discovery grain). A failure — say a query the
   *  renderer cancelled — fails the run: without the guard every enabled
   *  dimension, resource-level ones included, would join the grain and re-key
   *  (so prune or blank) every discovered baseline. */
  private async probeDimCardinality(
    deps: BaselineEngineDeps,
    dateRange: DateRange,
    opts: QueryContextOptions,
  ): Promise<{ cardinalityByColumn: Record<string, number>; lineItems: number }> {
    const enabledFields = [...new Set(opts.dimensions.builtIn.filter((d) => d.enabled !== false).map((d) => d.field))];
    const cardinalityByColumn: Record<string, number> = {};
    let lineItems = 0;
    const probe = buildDimCardinalityQuery(enabledFields, dateRange, opts);
    const row = (await deps.runPreparedQuery(probe.sql, probe.params, false))[0];
    if (row !== undefined) {
      for (const f of enabledFields) cardinalityByColumn[f] = num(row[f]);
      lineItems = num(row['row_count']);
    }
    return { cardinalityByColumn, lineItems };
  }

  /** Index current specs by scope identity: discovered ones for upsert-matching,
   *  manual ones so discovery never mints a duplicate for a pinned scope. */
  private indexSpecsByScope(): { existingByScope: Map<string, BaselineSpec>; manualScopes: Set<string> } {
    const existingByScope = new Map<string, BaselineSpec>();
    const manualScopes = new Set<string>();
    for (const s of this.specs.values()) {
      if (s.source === 'discovered') existingByScope.set(scopeKey(s.scope), s);
      else manualScopes.add(scopeKey(s.scope));
    }
    return { existingByScope, manualScopes };
  }

  /** Discovery steps 4–5: upsert a baseline for every live tuple — auto-ignoring
   *  low-value ones via triage status, but never overriding a status the user
   *  set themselves — then handle vanished discovered tuples (a grain change, or
   *  a scope that dropped to zero spend over the lookback; this runs on every
   *  recompute, not just grain changes). Prune the untouched ones so the list
   *  doesn't accumulate stale rows; keep the ones the user invested in but blank
   *  their history so they show insufficient-data rather than a stale band.
   *  Returns the ids whose history it set, which recomputeAll finalizes. */
  private reconcileDiscovered(args: {
    readonly tuples: ReadonlyMap<string, DiscoveredTuple>;
    readonly grain: readonly GrainDim[];
    readonly basis: BaselineCostBasis;
    readonly dailyByTuple: ReadonlyMap<string, readonly BaselineDailyPoint[]>;
    readonly historyEnd: string;
    /** UNCLAMPED whole-window auto-ignore threshold (minMonthlyCost × lookback
     *  months) — the same number the daily query's minTotalCost derives from. */
    readonly minTotal: number;
    /** Some provider has no data in the window, so a tuple missing from the
     *  results may just be one of its: keep vanished ones as they are. */
    readonly keepVanished: boolean;
  }): ReadonlySet<string> {
    const { existingByScope, manualScopes } = this.indexSpecsByScope();
    const refreshed = new Set<string>();

    const seenScopes = new Set<string>();
    // One timestamp for the whole batch — nothing reads per-tuple-distinct
    // times, and this skips thousands of Date allocations per recompute.
    const now = new Date().toISOString();
    for (const [key, tuple] of args.tuples) {
      const scope = buildScope(args.grain, tuple.values);
      const scopeId = scopeKey(scope);
      // The user already pinned this exact scope manually — don't mint a
      // duplicate 'discovered' baseline for it.
      if (manualScopes.has(scopeId)) continue;
      seenScopes.add(scopeId);
      const existing = existingByScope.get(scopeId);
      const spec: BaselineSpec = existing !== undefined
        ? { ...existing, basis: args.basis, basisSnapshotAt: now, updatedAt: now }
        : { id: randomUUID(), source: 'discovered', scope, basis: args.basis, basisSnapshotAt: now, createdAt: now, updatedAt: now };
      this.specs.set(spec.id, spec);
      // The daily query skips tuples under the auto-ignore threshold, so their
      // missing history means "not fetched", not "no spend". Blank it only when
      // nobody invested in the baseline; a user-edited one keeps its trend and
      // gets its own query in recomputeAll.
      const daily = args.dailyByTuple.get(key);
      if (daily !== undefined || !this.isUserEdited(spec.id)) {
        this.histories.set(spec.id, clampHistory(daily ?? [], args.historyEnd));
        refreshed.add(spec.id);
      }
      if (!this.userTriaged.has(spec.id)) {
        if (tuple.total < args.minTotal) this.triageStatuses.set(spec.id, 'ignored');
        else this.triageStatuses.delete(spec.id); // un-ignore once it grows past the threshold
      }
    }

    for (const [key, spec] of existingByScope) {
      if (seenScopes.has(key) || args.keepVanished) continue;
      if (this.isUserEdited(spec.id)) { this.histories.set(spec.id, []); refreshed.add(spec.id); }
      else this.forget(spec.id);
    }
    return refreshed;
  }

  /** Re-query one baseline's daily history and finalize it. Returns why, and
   *  leaves its history and snapshots exactly as they were, when its window has
   *  no readable data, or has a provider missing and the query found nothing
   *  (the scope's spend may sit on that provider); null once refreshed. */
  private async recomputeOne(deps: BaselineEngineDeps, spec: BaselineSpec): Promise<string | null> {
    const cfg = this.effectiveConfig();
    const dimensions = await deps.getQueryDimensions();
    const dateRange = lookbackRange(spec.basis.lagDays, cfg.lookbackDays);
    const providers = await deps.getQueryProviders('daily');
    const coverage = dataCoverage(providers, dateRange);
    if (coverage.kind === 'none') return coverage.reason;
    const basisScope = basisToCostScope(spec.basis);
    const groupBy = primaryGroupBy(spec.scope);
    // The query filters on the FULL scope, so the rollup-fit check must require
    // every filter column — not just the primary group-by — or a multi-dim scope
    // can route to a rollup missing a secondary filter column and fail to bind.
    const neededColumns = [
      ...new Set([
        ...Object.keys(scopeFilters(spec.scope)).map((k) => columnForDimension(dimensions, k)),
        columnForDimension(dimensions, String(groupBy)),
        'cost',
      ]),
    ];
    const mat = this.matSource(deps, providers.length, basisScope, dimensions, dateRange, neededColumns);
    const opts = {
      dataDir: deps.dataDir,
      dimensions,
      providers,
      accountReverseMap: await deps.getAccountReverseMap(),
      costScope: basisScope,
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
    if (points.length === 0 && coverage.kind === 'partial') return coverage.reason;
    this.histories.set(spec.id, clampHistory(points, dateRange.end));
    this.finalizeFromHistory(spec);
    return null;
  }

  /** Compute current/bands/savings/status from stored history, append a
   *  snapshot, and update bestAchieved. */
  private finalizeFromHistory(spec: BaselineSpec): void {
    const cfg = this.effectiveConfig();
    const history = this.histories.get(spec.id) ?? [];
    // No stored history (e.g. a baseline that became auto-ignored, vanished, or
    // whose scope spent nothing over the window) → nothing to snapshot, and drop
    // any snapshots from when it had data so the stored trend doesn't go stale.
    // Stats derive as insufficient-data. Only a query that actually ran can say
    // so: callers never get here when no cost data could be read at all.
    if (history.length === 0) { this.snapshots.delete(spec.id); return; }
    const runRate = runRateSeries(history, cfg.windowDays);
    const bands = computeBands(runRate, { lowerPct: cfg.lowerPct, upperPct: cfg.upperPct });
    const current = computeCurrent(history, cfg.windowDays);
    const eff = effectiveBands(bands, spec.manualBand, runRate.map((p) => p.cost));
    const savings = computeSavings(current, eff);
    const status = deriveStatus(current, eff, history.length, { minDataPoints: cfg.windowDays, subCentFloor: 0.01, overPctOverLower: 0 });
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
    const basisScope = basisToCostScope(spec.basis);
    const end = asDateString(settledEnd(spec.basis.lagDays));
    // `dateNDaysAgo(end, N)` then an inclusive BETWEEN spans N+1 calendar days;
    // subtract one so each window is exactly windowDays/lookbackDays days — matching
    // the divisors below.
    const trailingRange = { start: asDateString(dateNDaysAgo(end, Math.max(0, cfg.windowDays - 1))), end };
    const bandRange = { start: asDateString(dateNDaysAgo(end, Math.max(0, cfg.lookbackDays - 1))), end };
    const child = asDimensionId(childDimension);
    const accountReverseMap = await deps.getAccountReverseMap();
    const providers = await deps.getQueryProviders('daily');
    // Drift compares the two windows: if either can't be read, or they read
    // different providers, the missing data would show up as a spend change
    // (every child "improving" once sync stops). Report no drift instead.
    if (!sameCoverage(dataCoverage(providers, trailingRange), dataCoverage(providers, bandRange))) return [];

    const windowByChild = async (range: DateRange): Promise<Map<string, number>> => {
      const mat = this.matSource(deps, providers.length, basisScope, dimensions, range, [columnForDimension(dimensions, childDimension), 'cost']);
      const q = buildDailyCostsQuery(
        { dateRange: range, filters: scopeFilters(spec.scope), groupBy: child },
        {
          dataDir: deps.dataDir, dimensions,
          providers,
          accountReverseMap,
          costScope: basisScope,
          ...(mat === undefined ? {} : { materializedSource: mat }),
        },
      );
      const rows = await deps.runPreparedQuery(q.sql, q.params, mat !== undefined);
      const totals = new Map<string, number>();
      for (const r of rows) totals.set(str(r['group_name']), (totals.get(str(r['group_name'])) ?? 0) + num(r['cost']));
      return totals;
    };

    const [trailing, band] = await Promise.all([windowByChild(trailingRange), windowByChild(bandRange)]);
    const trailingDays = Math.max(1, cfg.windowDays);
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
    providerCount: number,
    costScope: CostScopeConfig,
    dimensions: DimensionsConfig,
    dateRange: { start: string; end: string },
    neededColumns: readonly string[],
  ): string | undefined {
    // The rollup store is bound to the FIRST provider's tree — a
    // multi-provider baseline routed through it would drop every other
    // provider's spend. Multi-provider recomputes read raw via the union.
    if (providerCount !== 1) return undefined;
    // Only use the rollup when the requested cost basis matches what the rollup
    // was built for — otherwise the pre-aggregated cost column is wrong.
    const built = deps.rollupStore.getBuiltSignature();
    if (built === null) return undefined;
    const sig = computeShapeSignature({
      dimensions,
      costMetric: costScope.costMetric,
      rules: costScope.rules,
      marketplaceAttribution: costScope.marketplaceAttribution,
      orgAccountsDigest: this.cachedOrgDigest,
    });
    if (sig !== built) return undefined;
    return deps.rollupStore.resolveSource({ requiredPeriods: periodsFor(dateRange), tier: 'daily', neededColumns });
  }

  private cachedOrgDigest = '';
  async primeOrgDigest(deps: BaselineEngineDeps): Promise<void> {
    try {
      const raw = await readFile(join(deps.stateDir, 'org-accounts.json'), 'utf-8');
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

function primaryGroupBy(scope: BaselineScope) {
  if (scope.kind === 'filter') {
    const keys = Object.keys(scope.filters);
    if (keys[0] !== undefined) return asDimensionId(keys[0]);
  }
  return asDimensionId('service');
}

/** The slice of a discovery-grain dimension the tuple folding needs. */
type GrainDim = { readonly name: DimensionId; readonly field: string };

interface DiscoveredTuple {
  readonly values: Record<string, string>;
  readonly total: number;
}

/** One tuple's grain values, pulled off a query row. */
function tupleValuesOf(r: RawRow, grain: readonly GrainDim[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const d of grain) values[d.field] = str(r[d.field]);
  return values;
}

/** Canonical per-run tuple identity. The totals and daily folds MUST share this
 *  exact key — reconcileDiscovered joins their maps by it, and a mismatch is
 *  silently swallowed as empty history (`get(key) ?? []`), not raised. */
function tupleKeyFor(grain: readonly GrainDim[], values: Record<string, string>): string {
  return grain.map((d) => `${d.name}=${values[d.field] ?? ''}`).sort(compareCodeUnits).join('&');
}

/** Folds the totals query's one-row-per-tuple result into a map keyed by tuple
 *  identity: grain values + total cost over the window. */
function foldTotalsByTuple(rows: readonly RawRow[], grain: readonly GrainDim[]): Map<string, DiscoveredTuple> {
  const tuples = new Map<string, DiscoveredTuple>();
  for (const r of rows) {
    const values = tupleValuesOf(r, grain);
    tuples.set(tupleKeyFor(grain, values), { values, total: num(r['total']) });
  }
  return tuples;
}

/** Folds the per-day discovery query's rows into daily history points grouped
 *  by tuple identity. */
function foldDailyByTuple(rows: readonly RawRow[], grain: readonly GrainDim[]): Map<string, BaselineDailyPoint[]> {
  const byTuple = new Map<string, BaselineDailyPoint[]>();
  for (const r of rows) {
    const key = tupleKeyFor(grain, tupleValuesOf(r, grain));
    let pts = byTuple.get(key);
    if (pts === undefined) { pts = []; byTuple.set(key, pts); }
    pts.push({ date: asDateString(str(r['date'])), cost: asDollars(num(r['cost'])) });
  }
  return byTuple;
}

function buildScope(grain: readonly GrainDim[], values: Record<string, string>): BaselineScope {
  const fm: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  for (const d of grain) fm[d.name] = [asTagValue(values[d.field] ?? '')];
  return { kind: 'filter', filters: fm };
}

function clampHistory(points: readonly BaselineDailyPoint[], end: string): readonly BaselineDailyPoint[] {
  const start = dateNDaysAgo(end, HISTORY_WINDOW_DAYS);
  return points
    .filter((p) => String(p.date) >= start && String(p.date) <= end)
    .sort(compareByDate);
}

async function snapshotBasis(deps: BaselineEngineDeps): Promise<BaselineCostBasis> {
  return costScopeToBasis(await deps.getCostScope());
}

function costScopeToBasis(cs: CostScopeConfig): BaselineCostBasis {
  return {
    costMetric: cs.costMetric,
    rules: cs.rules,
    ...(cs.marketplaceAttribution === undefined ? {} : { marketplaceAttribution: cs.marketplaceAttribution }),
    ...(cs.lagDays === undefined ? {} : { lagDays: cs.lagDays }),
  };
}

function basisToCostScope(basis: BaselineCostBasis): CostScopeConfig {
  return {
    costMetric: basis.costMetric,
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
  if (patch.triageStatus !== undefined && patch.triageStatus !== before.triageStatus) bits.push(`status ${before.triageStatus} → ${patch.triageStatus}`);
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
    minMonthlyCost: typeof raw['minMonthlyCost'] === 'number' ? asDollars(num(raw['minMonthlyCost'])) : base.minMonthlyCost,
    minSavings: typeof raw['minSavings'] === 'number' ? asDollars(num(raw['minSavings'])) : base.minSavings,
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

/** Migrate the pre-lifecycle status names persisted by earlier builds. */
const LEGACY_TRIAGE: Readonly<Record<string, BaselineTriageStatus>> = {
  interesting: 'tracking', confirmed: 'tracking', 'in-progress': 'acting',
  'false-positive': 'dismissed', 'auto-ignored': 'ignored',
};

function parseTriageStatus(v: unknown): BaselineTriageStatus | null {
  const s = str(v);
  for (const t of BASELINE_TRIAGE_STATUSES) if (t === s) return t;
  return LEGACY_TRIAGE[s] ?? null;
}

function parseStatusChange(raw: Record<string, unknown>): { from: BaselineTriageStatus; to: BaselineTriageStatus } {
  const norm = (v: unknown): BaselineTriageStatus => parseTriageStatus(v) ?? 'new';
  return { from: norm(raw['from']), to: norm(raw['to']) };
}
