import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asDateString,
  asDimensionId,
  asDollars,
  asTagValue,
  BASELINE_TRIAGE_STATUSES,
  BASELINES_STATE_VERSION,
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
  createBaselineValidator,
  deriveStatus,
  effectiveBands,
  estimateBytesPerRow,
  getAncestorPath,
  hasErrnoCode,
  logger,
  parseJsonObjectFile,
  quarantineFile,
  readTextIfExists,
  resolveDiscoveryGrain,
  runRateSeries,
  writeFileAtomic,
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
import { columnForDimension, providersEmptyForRange } from './handlers/query-utils.js';

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

type StateDoc = Readonly<Record<string, unknown>>;

/** The `version` both state files are written with. */
const STATE_VERSION = BASELINES_STATE_VERSION;

interface SpecsDoc {
  readonly baselines: readonly unknown[];
  readonly meta: StateDoc;
  readonly config: StateDoc | null;
}

interface DataDoc {
  readonly history: StateDoc;
  readonly snapshots: StateDoc;
}

/** null when a field the store rewrites wholesale has the wrong type (the
 *  whole file is then set aside rather than half-read and overwritten).
 *  Absent/null fields read as empty; a non-object config is ignored. */
function parseSpecsDoc(doc: StateDoc): SpecsDoc | null {
  const baselines = doc['baselines'] ?? [];
  const meta = doc['meta'] ?? {};
  if (!Array.isArray(baselines) || !isRecord(meta)) return null;
  return { baselines, meta, config: isRecord(doc['config']) ? doc['config'] : null };
}

function parseDataDoc(doc: StateDoc): DataDoc | null {
  const history = doc['history'] ?? {};
  const snapshots = doc['snapshots'] ?? {};
  return isRecord(history) && isRecord(snapshots) ? { history, snapshots } : null;
}

type StateRead<T> =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly doc: T }
  | { readonly status: 'set-aside' };

async function setAside(path: string, reason: string): Promise<void> {
  const movedTo = await quarantineFile(path);
  logger.error(`baselines: ${reason}; moved it aside and started afresh`, { file: path, movedTo });
}

/** Strictly read one persisted state file. Only ENOENT reads as 'missing'; any
 *  other read failure throws and leaves the file alone. A file that doesn't
 *  parse (a write torn under an older build, a hand edit) is moved aside —
 *  bytes kept for recovery — so the store can start it afresh. A file from a
 *  newer format throws: it must be neither half-read nor overwritten. */
async function readStateDoc<T>(path: string, parse: (doc: StateDoc) => T | null): Promise<StateRead<T>> {
  const text = await readTextIfExists(path);
  if (text === null) return { status: 'missing' };
  const raw = parseJsonObjectFile(text);
  const version = raw?.['version'];
  if (typeof version === 'number' && version > STATE_VERSION) {
    throw new Error(`${path} was written by a newer version of CostGoblin (format ${String(version)}); refusing to load or overwrite it`);
  }
  const doc = raw === null ? null : parse(raw);
  if (doc !== null) return { status: 'ok', doc };
  await setAside(path, 'unreadable state file');
  return { status: 'set-aside' };
}

/** A persisted spec that fails validation today, kept verbatim (with its meta
 *  entry) so saves write it back. */
interface HiddenSpec {
  readonly entry: StateDoc;
  readonly meta: unknown;
}

type LoadState =
  | { readonly status: 'unloaded' }
  | { readonly status: 'loading'; readonly done: Promise<void> }
  | { readonly status: 'loaded' };

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
  /** Persisted specs that fail validation today (e.g. their scope names a
   *  dimension that has since been disabled), by id. Hidden from every query
   *  but written back — with their meta, history and snapshots — on save, and
   *  re-validated on every access so they return as soon as their dimension
   *  does: deleting them over what may be a temporary config change would
   *  lose the user's baselines and triage for good. */
  private readonly hiddenSpecs = new Map<string, HiddenSpec>();
  /** 'loaded' only once both state files have been read and committed. Until
   *  then save() refuses to run, so a failed or pending load can never
   *  overwrite the files with a partial (or empty) in-memory state. */
  private loadState: LoadState = { status: 'unloaded' };
  /** Saves run one at a time, each writing the state as of when it runs. */
  private saveChain: Promise<void> = Promise.resolve();
  private recomputing = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  // --- persistence ------------------------------------------------------------

  private specsPath(): string { return join(this.stateDir, 'baselines.json'); }
  private dataPath(): string { return join(this.stateDir, 'baselines-data.json'); }

  async load(deps: BaselineEngineDeps): Promise<void> {
    if (this.loadState.status === 'loaded') {
      await this.reviveHiddenSpecs(deps);
      return;
    }
    if (this.loadState.status === 'unloaded') {
      const done = this.loadOnce(deps).then(
        () => { this.loadState = { status: 'loaded' }; },
        (err: unknown) => { this.loadState = { status: 'unloaded' }; throw err; },
      );
      this.loadState = { status: 'loading', done };
    }
    await this.loadState.done;
  }

  /** Read both state files, then commit them to memory in one synchronous
   *  step. A failure before the commit leaves the store empty and unloaded:
   *  the error reaches the caller, the next access retries, and nothing is
   *  saved in between. */
  private async loadOnce(deps: BaselineEngineDeps): Promise<void> {
    try {
      const specs = await readStateDoc(this.specsPath(), parseSpecsDoc);
      // Before the (much larger) data file: the dimensions lookup is the
      // load's other way to fail.
      const dimensions = specs.status === 'ok' ? await deps.getQueryDimensions() : null;
      const [data] = await Promise.all([
        // The data file's per-baseline history belongs to the specs just set
        // aside — set it aside with them, so restoring those specs by hand
        // gets their snapshot trend back too (a save would prune it).
        specs.status === 'set-aside' ? this.setAsideDataFile() : readStateDoc(this.dataPath(), parseDataDoc),
        this.primeOrgDigest(deps),
      ]);
      if (specs.status === 'ok' && dimensions !== null) this.ingestSpecs(specs.doc, dimensions);
      if (data.status === 'ok') this.ingestData(data.doc);
    } catch (err: unknown) {
      logger.error('baselines: failed to load saved baselines; retrying on next access', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async setAsideDataFile(): Promise<StateRead<DataDoc>> {
    try {
      await setAside(this.dataPath(), 'history paired with an unreadable baselines.json');
      return { status: 'set-aside' };
    } catch (err: unknown) {
      if (hasErrnoCode(err, ['ENOENT'])) return { status: 'missing' };
      throw err;
    }
  }

  private ingestSpecs(doc: SpecsDoc, dimensions: DimensionsConfig): void {
    if (doc.config !== null) this.userConfig = parseConfig(doc.config);
    let malformed = 0;
    for (const entry of doc.baselines) {
      // No string id: not a spec any build could validate, and no key to
      // carry its meta by.
      if (!isRecord(entry) || typeof entry['id'] !== 'string') { malformed += 1; continue; }
      const id = entry['id'];
      this.hiddenSpecs.set(id, { entry, meta: Object.hasOwn(doc.meta, id) ? doc.meta[id] : undefined });
    }
    this.admitValidSpecs(dimensions);
    if (malformed > 0) logger.warn('baselines: dropped malformed spec entries', { count: malformed });
    if (this.hiddenSpecs.size > 0) {
      logger.warn('baselines: kept specs that failed validation (hidden until they validate)', { count: this.hiddenSpecs.size });
    }
  }

  /** Move every hidden spec that validates against `dimensions` into the live
   *  set, with its meta. Validation is per spec, not atomic — one bad spec
   *  (e.g. its scope references a since-renamed dimension) must not discard
   *  every other baseline, including user-triaged ones with notes/bands. */
  private admitValidSpecs(dimensions: DimensionsConfig): void {
    const validate = createBaselineValidator(dimensions);
    for (const [id, hidden] of this.hiddenSpecs) {
      const spec = validate(hidden.entry);
      if (spec === null) continue;
      this.hiddenSpecs.delete(id);
      this.specs.set(spec.id, spec);
      if (isRecord(hidden.meta)) this.ingestSpecMeta(spec.id, hidden.meta);
    }
  }

  /** Dimensions change at runtime; a hidden spec whose dimension is back must
   *  rejoin before create()'s duplicate check or discovery see its scope. */
  private async reviveHiddenSpecs(deps: BaselineEngineDeps): Promise<void> {
    if (this.hiddenSpecs.size === 0) return;
    // Opportunistic: an unreadable dimensions config just leaves them hidden.
    const dimensions = await deps.getQueryDimensions().catch(() => null);
    if (dimensions !== null) this.admitValidSpecs(dimensions);
  }

  private ingestSpecMeta(id: string, m: StateDoc): void {
    if (isRecord(m['triage'])) this.triages.set(id, parseTriage(m['triage']));
    if (typeof m['bestAchieved'] === 'number') this.bestAchieved.set(id, m['bestAchieved']);
    if (typeof m['triageStatus'] === 'string') {
      const t = parseTriageStatus(m['triageStatus']);
      if (t !== null) this.triageStatuses.set(id, t);
    }
    if (m['userTriaged'] === true) this.userTriaged.add(id);
  }

  private ingestData(doc: DataDoc): void {
    for (const [id, pts] of Object.entries(doc.history)) {
      if (Array.isArray(pts)) this.histories.set(id, parsePoints(pts));
    }
    for (const [id, snaps] of Object.entries(doc.snapshots)) {
      if (Array.isArray(snaps)) this.snapshots.set(id, parseSnapshots(snaps));
    }
  }

  /** Persist the state. 'specs' skips rewriting baselines-data.json, for
   *  changes that can't touch history, snapshots or which baselines exist
   *  (triage, names, bands, config) — that file is by far the larger one. */
  private async save(scope: 'specs' | 'all' = 'all'): Promise<void> {
    if (this.loadState.status !== 'loaded') throw new Error('baselines: refusing to save before the saved baselines have loaded');
    const next = this.saveChain.then(() => this.writeState(scope));
    // Keep the chain going past a failed write; the caller still sees its own.
    this.saveChain = next.catch(() => undefined);
    await next;
  }

  private async writeState(scope: 'specs' | 'all'): Promise<void> {
    // Hidden specs are persisted exactly like live ones, their data included.
    const persisted = (id: string): boolean => this.specs.has(id) || this.hiddenSpecs.has(id);
    // Object.fromEntries, not keyed assignment: an id of "__proto__" would
    // hit the prototype setter and vanish from the JSON.
    const meta = Object.fromEntries([
      ...[...this.hiddenSpecs].filter(([, h]) => h.meta !== undefined).map(([id, h]): [string, unknown] => [id, h.meta]),
      ...[...this.specs.keys()].map((id): [string, unknown] => [id, {
        triage: this.triages.get(id) ?? { notes: [] },
        bestAchieved: this.bestAchieved.get(id) ?? null,
        ...(this.triageStatuses.has(id) ? { triageStatus: this.triageStatuses.get(id) } : {}),
        ...(this.userTriaged.has(id) ? { userTriaged: true } : {}),
      }]),
    ]);
    const specsDoc = {
      version: STATE_VERSION,
      config: this.userConfig,
      baselines: [...this.specs.values(), ...[...this.hiddenSpecs.values()].map((h) => h.entry)],
      meta,
    };
    const writes = [writeFileAtomic(this.specsPath(), JSON.stringify(specsDoc, null, 2))];
    if (scope === 'all') {
      // Drop history/snapshots orphaned by a delete that raced a recompute, so
      // they don't survive across restarts.
      const dataDoc = {
        version: STATE_VERSION,
        history: Object.fromEntries([...this.histories].filter(([id]) => persisted(id))),
        snapshots: Object.fromEntries([...this.snapshots].filter(([id]) => persisted(id))),
      };
      writes.push(writeFileAtomic(this.dataPath(), JSON.stringify(dataDoc, null, 2)));
    }
    // Let both finish before the next queued save starts, even if one fails.
    const failed = (await Promise.allSettled(writes)).find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
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

  async setConfig(deps: BaselineEngineDeps, config: BaselinesDiscoveryConfig): Promise<BaselinesConfigState> {
    await this.load(deps);
    this.userConfig = config;
    await this.save('specs');
    return this.getConfigState();
  }

  async resetConfig(deps: BaselineEngineDeps): Promise<BaselinesConfigState> {
    await this.load(deps);
    this.userConfig = null;
    await this.save('specs');
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

    await this.save('specs');
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
          await this.recomputeOne(deps, spec);
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
   *  history and derived stats, broadcasting throttled progress. */
  private async recomputeAll(deps: BaselineEngineDeps, startFresh: boolean): Promise<void> {
    // Start fresh: wipe ALL discovered baselines (incl. user-edited) so the
    // new grain rediscovers from a clean slate. Manual baselines are kept.
    if (startFresh) {
      for (const s of this.specs.values()) if (s.source === 'discovered') this.forget(s.id);
      for (const [id, hidden] of this.hiddenSpecs) if (hidden.entry['source'] === 'discovered') this.hiddenSpecs.delete(id);
    }
    this.setStatus({ state: 'running', phase: 'discovering', done: 0, total: 0 });
    await this.discover(deps);
    const specs = [...this.specs.values()];
    const total = specs.length;
    let done = 0;
    this.setStatus({ state: 'running', phase: 'computing', done, total });
    // Throttle progress broadcasts: with thousands of baselines, one IPC
    // message per item would flood the renderer.
    const step = Math.max(1, Math.floor(total / 100));
    for (const spec of specs) {
      // `specs` was snapshotted before the awaits below; skip any baseline
      // the user deleted mid-recompute so we don't re-populate its history.
      if (!this.specs.has(spec.id)) continue;
      // Only discovered FILTER baselines had their history set during
      // discover(); everything else (manual, or any view-scoped spec) needs
      // a per-baseline query here, or it would finalize on stale history.
      if (spec.source === 'discovered' && spec.scope.kind === 'filter') this.finalizeFromHistory(spec);
      else await this.recomputeOne(deps, spec);
      done += 1;
      if (done % step === 0 || done === total) this.setStatus({ state: 'running', phase: 'computing', done, total });
    }
  }

  private async discover(deps: BaselineEngineDeps): Promise<void> {
    const cfg = this.effectiveConfig();
    const dimensions = await deps.getQueryDimensions();
    const costScope = await deps.getCostScope();
    const end = dateNDaysAgo(todayUtc(), costScope.lagDays ?? 2);
    const start = dateNDaysAgo(end, cfg.lookbackDays);
    const dateRange = { start: asDateString(start), end: asDateString(end) };
    const providers = await deps.getQueryProviders('daily');
    if (providers.length === 0) { logger.info('baselines: discovery skipped — no provider configured'); return; }
    if (providersEmptyForRange(providers, dateRange)) { logger.info('baselines: discovery skipped — no data in range'); return; }
    const opts = {
      dataDir: deps.dataDir,
      dimensions,
      providers,
      accountReverseMap: await deps.getAccountReverseMap(),
      costScope,
    };

    // 1) Probe cardinality of the enabled built-ins to drop high-card dims.
    const { cardinalityByColumn, lineItems } = await this.probeDimCardinality(deps, dateRange, opts);

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

    // 4+5) Upsert a baseline per live tuple; prune or blank the vanished ones.
    const basis = await snapshotBasis(deps);
    // ^ last await before the synchronous reconcile: it indexes this.specs
    // after this point, so baselines the user deleted mid-discovery stay gone.
    this.reconcileDiscovered({ tuples, grain, basis, dailyByTuple, historyEnd: dateRange.end, minTotal });
  }

  /** Probe cardinality of the enabled built-ins (used to drop high-cardinality
   *  dims from the default discovery grain). A failed probe degrades to the
   *  empty grain guard rather than failing the whole recompute. */
  private async probeDimCardinality(
    deps: BaselineEngineDeps,
    dateRange: DateRange,
    opts: QueryContextOptions,
  ): Promise<{ cardinalityByColumn: Record<string, number>; lineItems: number }> {
    const enabledFields = [...new Set(opts.dimensions.builtIn.filter((d) => d.enabled !== false).map((d) => d.field))];
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
   *  their history so they show insufficient-data rather than a stale band. */
  private reconcileDiscovered(args: {
    readonly tuples: ReadonlyMap<string, DiscoveredTuple>;
    readonly grain: readonly GrainDim[];
    readonly basis: BaselineCostBasis;
    readonly dailyByTuple: ReadonlyMap<string, readonly BaselineDailyPoint[]>;
    readonly historyEnd: string;
    /** UNCLAMPED whole-window auto-ignore threshold (minMonthlyCost × lookback
     *  months) — the same number the daily query's minTotalCost derives from. */
    readonly minTotal: number;
  }): void {
    const { existingByScope, manualScopes } = this.indexSpecsByScope();

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
      this.histories.set(spec.id, clampHistory(args.dailyByTuple.get(key) ?? [], args.historyEnd));
      if (!this.userTriaged.has(spec.id)) {
        if (tuple.total < args.minTotal) this.triageStatuses.set(spec.id, 'ignored');
        else this.triageStatuses.delete(spec.id); // un-ignore once it grows past the threshold
      }
      // finalizeFromHistory runs once for every spec in recomputeAll()'s loop.
    }

    for (const [key, spec] of existingByScope) {
      if (seenScopes.has(key)) continue;
      if (this.isUserEdited(spec.id)) this.histories.set(spec.id, []);
      else this.forget(spec.id);
    }
  }

  private async recomputeOne(deps: BaselineEngineDeps, spec: BaselineSpec): Promise<void> {
    const cfg = this.effectiveConfig();
    const dimensions = await deps.getQueryDimensions();
    const end = dateNDaysAgo(todayUtc(), spec.basis.lagDays ?? 2);
    const start = dateNDaysAgo(end, cfg.lookbackDays);
    const dateRange = { start: asDateString(start), end: asDateString(end) };
    const providers = await deps.getQueryProviders('daily');
    if (providers.length === 0 || providersEmptyForRange(providers, dateRange)) { this.histories.set(spec.id, []); this.finalizeFromHistory(spec); return; }
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
    this.histories.set(spec.id, clampHistory(points, dateRange.end));
    this.finalizeFromHistory(spec);
  }

  /** Compute current/bands/savings/status from stored history, append a
   *  snapshot, and update bestAchieved. */
  private finalizeFromHistory(spec: BaselineSpec): void {
    const cfg = this.effectiveConfig();
    const history = this.histories.get(spec.id) ?? [];
    // No stored history (e.g. a baseline that became auto-ignored or vanished)
    // → nothing to snapshot, and drop any snapshots from when it had data so the
    // stored trend doesn't go stale. Stats derive as insufficient-data.
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
    const end = dateNDaysAgo(todayUtc(), spec.basis.lagDays ?? 2);
    // `dateNDaysAgo(end, N)` then an inclusive BETWEEN spans N+1 calendar days;
    // subtract one so each window is exactly windowDays/lookbackDays days — matching
    // the divisors below.
    const trailingStart = dateNDaysAgo(end, Math.max(0, cfg.windowDays - 1));
    const bandStart = dateNDaysAgo(end, Math.max(0, cfg.lookbackDays - 1));
    const child = asDimensionId(childDimension);
    const accountReverseMap = await deps.getAccountReverseMap();
    const providers = await deps.getQueryProviders('daily');

    const windowByChild = async (winStart: string): Promise<Map<string, number>> => {
      if (providers.length === 0) return new Map<string, number>();
      const range = { start: asDateString(winStart), end: asDateString(end) };
      if (providersEmptyForRange(providers, range)) return new Map<string, number>();
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

    const [trailing, band] = await Promise.all([windowByChild(trailingStart), windowByChild(bandStart)]);
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
  const cs = await deps.getCostScope();
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
