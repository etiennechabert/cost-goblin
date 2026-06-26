import type { DuckDBClient, RawRow } from '../duckdb-client.js';
import { LRUCache } from '../lru-cache.js';
import { QueryLog } from '../query-log.js';
import { awaitWithTimeout } from '../async-timeout.js';
import { RollupStore, type BuildPartitionSql, type RollupShape } from '../rollup-store.js';
import {
  asDimensionId,
  applyNormalizationRule,
  applyRegionFriendlyNames,
  applyStripPatterns,
  loadConfig,
  loadDimensions,
  loadOrgTree,
  loadViews,
  loadCostScope,
  mergeBuiltInExclusionRules,
  buildRollupPartitionQuery,
  computeShapeSignature,
  computeOrgAccountsDigest,
  rollupGrainColumns,
  parseEtagsJson,
  getEtagFileName,
  listLocalMonths,
  logger,
  isStringRecord,
} from '@costgoblin/core';
import { buildAccountReverseMap } from './query-utils.js';
import type {
  BuiltInDimension,
  CostGoblinConfig,
  CostScopeConfig,
  DimensionsConfig,
  OrgNode,
  RegionEnrichment,
  SyncStatus,
  ViewsConfig,
} from '@costgoblin/core';

const DEFAULT_BUILT_INS: readonly BuiltInDimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name', description: 'AWS account the cost was charged to. Main axis for org/team-level rollups.', useOrgAccounts: true },
  { name: asDimensionId('region'), label: 'Region', field: 'region', description: 'AWS region where the resource ran. Useful for spotting unintended multi-region sprawl.', useRegionNames: true },
  // Two pure-enrichment dims derived from the same `region` column: Country
  // and Continent group multiple regions into geo buckets via SSM metadata.
  // Off by default — not everyone needs geo rollups, and without an SSM sync
  // they'd just mirror the Region dim.
  { name: asDimensionId('region_country'), label: 'Country', field: 'region', description: 'ISO country code derived from the region (DE, US, IE). Useful for data-residency and geo chargeback.', enabled: false },
  { name: asDimensionId('region_continent'), label: 'Continent', field: 'region', description: 'AWS geographic bucket (EU, NA, AS) derived from the region. Useful for continent-level summaries.', enabled: false },
  { name: asDimensionId('service'), label: 'AWS Service', field: 'service', description: 'AWS service code (EC2, S3, RDS, etc.) — the broadest "what cost me this?" view.' },
  { name: asDimensionId('service_family'), label: 'Service Category', field: 'service_family', description: 'Higher-level product category (Compute, Storage, Database). Good for exec summaries.' },
  { name: asDimensionId('line_item_type'), label: 'Line Item Type', field: 'line_item_type', description: 'Usage vs Tax vs Credit vs Discount. Filter this to isolate real usage from billing adjustments.' },
  { name: asDimensionId('usage_type'), label: 'Usage Type', field: 'usage_type', description: 'Fine-grained usage string like USE2-BoxUsage:t3.medium. Use for instance/storage-tier breakdowns.', enabled: false },
  { name: asDimensionId('operation'), label: 'Operation', field: 'operation', description: 'API operation billed for (RunInstances, GetObject). Useful for API-level cost attribution.', enabled: false },
  // Very high cardinality — disabled by default so the normal filter/nav
  // pickers stay scannable. The Explorer references it directly so
  // click-to-filter on a resource cell works whether or not this dim is
  { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id', description: 'AWS resource ID or ARN (i-0abc…, arn:aws:rds:…). High-cardinality — useful for drilling into specific resources.' },
];

/** Renames we want propagated to existing configs. Only overrides the stored
 *  label when it still matches the previous default — if the user had typed
 *  their own label we leave it alone. */
const LEGACY_LABEL_RENAMES: Record<string, { from: string; to: string }> = {
  service: { from: 'Service', to: 'AWS Service' },
  service_family: { from: 'Service Family', to: 'Service Category' },
};

function mergeDefaultBuiltIns(loaded: DimensionsConfig): DimensionsConfig {
  const defaultsByName = new Map(DEFAULT_BUILT_INS.map(d => [d.name, d]));
  // Backfill description on existing entries for any default whose config
  // predates the description field. User-set fields (label, aliases, etc.)
  // are kept — we only fill a missing description.
  // Also backfill useRegionNames=true on the Region dim so pre-existing
  // configs don't regress from friendly names back to raw codes now that the
  // alias injection is gated on this flag.
  const backfilled = loaded.builtIn.map(d => {
    let next = d;
    const rename = LEGACY_LABEL_RENAMES[d.name];
    if (rename?.from === next.label) {
      next = { ...next, label: rename.to };
    }
    if (next.description === undefined) {
      const def = defaultsByName.get(next.name);
      if (def?.description !== undefined) next = { ...next, description: def.description };
    }
    // Only the plain Region dim — Country/Continent share field='region' but
    // their own enrichment branches by name, so useRegionNames would be a
    // meaningless setting on them (and would pollute the saved YAML).
    if (next.name === 'region' && next.useRegionNames === undefined) {
      next = { ...next, useRegionNames: true };
    }
    return next;
  });
  const have = new Set(backfilled.map(d => d.name));
  const missing = DEFAULT_BUILT_INS.filter(d => !have.has(d.name));
  const changed = backfilled.some((d, i) => d !== loaded.builtIn[i]);
  if (missing.length === 0 && !changed) return loaded;
  return {
    builtIn: [...backfilled, ...missing],
    tags: loaded.tags,
    ...(loaded.order === undefined ? {} : { order: loaded.order }),
  };
}
export interface IpcContext {
  readonly db: DuckDBClient;
  readonly syncClient: import('../sync-client.js').SyncClient;
  readonly configPath: string;
  readonly dimensionsPath: string;
  readonly orgTreePath: string;
  readonly viewsPath: string;
  readonly costScopePath: string;
  readonly dataDir: string;
}

export interface OrgTreeConfig {
  readonly tree: readonly OrgNode[];
}

export interface AppState {
  config: CostGoblinConfig | null;
  dimensions: DimensionsConfig | null;
  orgTree: OrgTreeConfig | null;
  views: ViewsConfig | null;
  costScope: CostScopeConfig | null;
  syncStatuses: Record<string, SyncStatus>;
  accountMap: Map<string, string> | null;
  accountReverseMap: Map<string, readonly string[]> | null;
  regionMap: Map<string, RegionEnrichment> | null;
  orgAccountsPath: string | undefined | null;
}

export interface AppContext {
  readonly ctx: IpcContext;
  readonly state: AppState;
  readonly getConfig: () => Promise<CostGoblinConfig>;
  /** Raw user-facing dimensions config — used by the editor IPC handlers
   *  (the alias textarea must show ONLY user aliases, not the SSM-derived
   *  region name entries we splice in for queries). */
  readonly getDimensions: () => Promise<DimensionsConfig>;
  /** Dimensions enriched for query-time use: Region's aliases get the
   *  SSM-derived friendly names mixed in. Use this in every query handler. */
  readonly getQueryDimensions: () => Promise<DimensionsConfig>;
  readonly getOrgTreeConfig: () => Promise<OrgTreeConfig>;
  readonly getViews: () => Promise<ViewsConfig>;
  readonly getCostScope: () => Promise<CostScopeConfig>;
  readonly getAccountMap: () => Promise<Map<string, string>>;
  readonly getAccountReverseMap: () => Promise<Map<string, readonly string[]>>;
  readonly getRegionMap: () => Promise<Map<string, RegionEnrichment>>;
  readonly getOrgAccountsPath: () => Promise<string | undefined>;
  /** Columns present in the user's CUR parquet files for the given tier.
   *  CUR exports vary by version and by "Include Resource IDs" / "Include
   *  Net Columns" settings — not every export has
   *  reservation_effective_cost, savings_plan_savings_plan_effective_cost,
   *  or line_item_net_*. Cached per-tier for the session; invalidated on
   *  explicit reset via invalidateColumnCache. */
  readonly getAvailableColumns: (tier: 'daily' | 'hourly') => Promise<ReadonlySet<string>>;
  /** Build-affecting shape signature for a dimensions config — compare against
   *  rollupStore.getBuiltSignature() to tell if the built rollup matches a grain. */
  readonly signatureForDimensions: (dims: DimensionsConfig) => Promise<string>;
  readonly queryLog: QueryLog;
  /** Persistent per-period pre-aggregated rollup backing dashboard queries. */
  readonly rollupStore: RollupStore;
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  readonly runPreparedQuery: (sql: string, params: readonly unknown[], materialized?: boolean) => Promise<RawRow[]>;
  readonly invalidateConfig: () => void;
  readonly invalidateDimensions: () => void;
  readonly invalidateViews: () => void;
  readonly invalidateCostScope: () => void;
  readonly invalidateColumnCache: () => void;
  readonly warmupBase: () => void;
  /** Re-roll the rollup partitions for the periods a sync changed. */
  readonly maintainRollup: (changedPeriods: readonly string[]) => void;
  /** Resolve once the latest cost_base warmup settles (true if the base is
   *  ready, false if it timed out or no base was built). Lets the renderer
   *  hold the startup prewarm until the in-memory base exists, so those probes
   *  don't race the materialize with concurrent raw-parquet scans. */
  readonly awaitWarmup: (timeoutMs: number) => Promise<boolean>;
  readonly clearAllCaches: () => Promise<void>;
}

async function loadAccountCsv(
  rawDir: string,
  fs: typeof import('node:fs/promises'),
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const entries = await fs.readdir(rawDir);
    const csvFile = entries.find(e => e.toLowerCase().endsWith('.csv') && e.toLowerCase().includes('account'));
    if (csvFile !== undefined) {
      const content = await fs.readFile((await import('node:path')).join(rawDir, csvFile), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const cols = line.split(',').map(c => c.replaceAll(/^"|"$/g, '').trim());
        const id = cols[0] ?? '';
        const name = cols[4] ?? '';
        if (id.length > 0 && name.length > 0) map.set(id, name);
      }
    }
  } catch { /* no raw dir */ }
  return map;
}

function applyAccountNameTransforms(
  raw: Map<string, string>,
  normalize: import('@costgoblin/core').NormalizationRule | undefined,
  patterns: readonly string[] | undefined,
): Map<string, string> {
  if (normalize === undefined && (patterns === undefined || patterns.length === 0)) return raw;
  return new Map([...raw].map(([id, name]) => {
    let v = name;
    if (normalize !== undefined) v = applyNormalizationRule(v, normalize);
    if (patterns !== undefined && patterns.length > 0) v = applyStripPatterns(v, patterns);
    return [id, v];
  }));
}

function extractAccountTagEntry(acct: unknown): { id: string; tags: Record<string, string>; ouPath: string } | null {
  if (!isStringRecord(acct)) return null;
  const id = acct['id'];
  const tags = acct['tags'];
  if (typeof id !== 'string' || !isStringRecord(tags)) return null;
  const stringTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (typeof v === 'string') stringTags[k] = v;
  }
  const ouPath = typeof acct['ouPath'] === 'string' ? acct['ouPath'] : '';
  return { id, tags: stringTags, ouPath };
}

async function generateFlatOrgTags(baseDir: string, flatPath: string): Promise<string | undefined> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  try {
    const raw = await fs.readFile(path.join(baseDir, 'org-accounts.json'), 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    if (!isStringRecord(parsed) || !Array.isArray(parsed['accounts'])) return undefined;
    const tagLookup: { id: string; tags: Record<string, string> }[] = [];
    for (const acct of parsed['accounts']) {
      const entry = extractAccountTagEntry(acct);
      if (entry !== null) tagLookup.push(entry);
    }
    await fs.writeFile(flatPath, JSON.stringify(tagLookup));
    return flatPath;
  } catch {
    return undefined;
  }
}

export function createAppContext(ctx: IpcContext): AppContext {
  const state: AppState = {
    config: null,
    dimensions: null,
    orgTree: null,
    views: null,
    costScope: null,
    syncStatuses: {},
    accountMap: null,
    accountReverseMap: null,
    regionMap: null,
    orgAccountsPath: null,
  };

  async function getConfig(): Promise<CostGoblinConfig> {
    if (state.config !== null) return state.config;
    const config = await loadConfig(ctx.configPath);
    state.config = config;
    return config;
  }

  async function getDimensions(): Promise<DimensionsConfig> {
    if (state.dimensions !== null) return state.dimensions;
    const dimensions = await loadDimensions(ctx.dimensionsPath);
    // Fill in any missing default built-ins for users whose dimensions.yaml
    // predates them. Existing entries are kept intact — we only add, never
    // modify. The additions are in-memory; the next dimensions:save-config
    // persists them to disk.
    const merged = mergeDefaultBuiltIns(dimensions);
    state.dimensions = merged;
    return merged;
  }

  async function getOrgTreeConfig(): Promise<OrgTreeConfig> {
    if (state.orgTree !== null) return state.orgTree;
    const orgTree = await loadOrgTree(ctx.orgTreePath);
    state.orgTree = orgTree;
    return orgTree;
  }

  async function getViews(): Promise<ViewsConfig> {
    if (state.views !== null) return state.views;
    const views = await loadViews(ctx.viewsPath);
    state.views = views;
    return views;
  }

  async function getCostScope(): Promise<CostScopeConfig> {
    if (state.costScope !== null) return state.costScope;
    const loaded = await loadCostScope(ctx.costScopePath);
    const merged = mergeBuiltInExclusionRules(loaded);
    state.costScope = merged;
    return merged;
  }

  async function getAccountMap(): Promise<Map<string, string>> {
    if (state.accountMap !== null) return state.accountMap;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const baseDir = path.dirname(ctx.dataDir);

    const dimensions = await getDimensions();
    const accountDim = dimensions.builtIn.find(d => d.field === 'account_id');
    const preferOrg = accountDim?.useOrgAccounts === true;
    const tagKey = accountDim?.accountNameFromTag;

    const fromOrg = () => loadOrgAccountsMap(ctx.dataDir, tagKey);
    const fromCsv = () => loadAccountCsv(path.join(baseDir, 'raw'), fs);

    const primary = preferOrg ? await fromOrg() : await fromCsv();
    const fallback = preferOrg ? await fromCsv() : await fromOrg();
    const raw = primary.size > 0 ? primary : fallback;

    const map = applyAccountNameTransforms(raw, accountDim?.normalize, accountDim?.nameStripPatterns);

    if (map.size > 0) {
      logger.info(`Loaded account mapping (${preferOrg ? 'org-data' : 'csv'} preferred): ${String(map.size)} accounts`);
    }
    state.accountMap = map;
    return map;
  }

  async function getAccountReverseMap(): Promise<Map<string, readonly string[]>> {
    if (state.accountReverseMap !== null) return state.accountReverseMap;
    const accountMap = await getAccountMap();
    const reverseMap = buildAccountReverseMap(accountMap);
    state.accountReverseMap = reverseMap;
    return reverseMap;
  }

  async function getOrgAccountsPath(): Promise<string | undefined> {
    if (state.orgAccountsPath !== null) return state.orgAccountsPath;
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const baseDir = path.dirname(ctx.dataDir);
    const flatPath = path.join(baseDir, 'org-account-tags.json');
    let result: string | undefined;
    try {
      // Probe the existing flat file's schema — older builds wrote {id, tags}
      // only, but the OU Path fallback needs an `ouPath` field. Regenerate if
      // missing so DuckDB can resolve `ouPath AS fallback_…`.
      const raw = await fs.readFile(flatPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const hasOuPath = Array.isArray(parsed)
        && (parsed.length === 0 || (isStringRecord(parsed[0]) && 'ouPath' in parsed[0]));
      result = hasOuPath ? flatPath : await generateFlatOrgTags(baseDir, flatPath);
    } catch {
      result = await generateFlatOrgTags(baseDir, flatPath);
    }
    state.orgAccountsPath = result;
    return result;
  }

  function parseRegionEntries(regions: Record<string, unknown>, map: Map<string, RegionEnrichment>): void {
    for (const [code, info] of Object.entries(regions)) {
      if (!isStringRecord(info)) continue;
      const longName = info['longName'];
      if (typeof longName !== 'string' || longName.length === 0) continue;
      const country = typeof info['country'] === 'string' ? info['country'] : '';
      const continent = typeof info['continent'] === 'string' ? info['continent'] : '';
      map.set(code, { longName, country, continent });
    }
  }

  async function getRegionMap(): Promise<Map<string, RegionEnrichment>> {
    if (state.regionMap !== null) return state.regionMap;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const map = new Map<string, RegionEnrichment>();
    try {
      const raw = await fs.readFile(path.join(path.dirname(ctx.dataDir), 'region-names.json'), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isStringRecord(parsed) && isStringRecord(parsed['regions'])) {
        parseRegionEntries(parsed['regions'], map);
      }
    } catch { /* no region sync yet */ }
    state.regionMap = map;
    return map;
  }

  async function getQueryDimensions(): Promise<DimensionsConfig> {
    const dims = await getDimensions();
    const regionMap = await getRegionMap();
    return applyRegionFriendlyNames(dims, regionMap);
  }

  // Probe parquet columns once per tier and cache. Used to gate
  // optional cost columns (reservation_effective_cost,
  // savings_plan_savings_plan_effective_cost, etc.) that ship only
  // when the user's CUR has "Include Resource IDs" enabled. Without
  // the probe, every query that references those columns errors out
  // for CURs that omit them — even though we could degrade to
  // unblended.
  const columnCache = new Map<string, Promise<ReadonlySet<string>>>();

  async function getAvailableColumns(tier: 'daily' | 'hourly'): Promise<ReadonlySet<string>> {
    const cached = columnCache.get(tier);
    if (cached !== undefined) return cached;
    const fetch = (async (): Promise<ReadonlySet<string>> => {
      try {
        const months = await listLocalMonths(ctx.dataDir, tier);
        if (months.length === 0) {
          // No data on disk for this tier — log loudly because the silent
          // fallback used to surface as misleading "Degraded" warnings in
          // Cost Scope when capability checks interpreted the empty set as
          // "all columns missing."
          logger.warn('column-probe: no months on disk', { tier, dataDir: ctx.dataDir });
          return new Set<string>();
        }
        // Latest month sample is enough — CUR schema is stable across months
        // within a billing report (AWS bumps schema on version changes, rare
        // and user-initiated). Recent months also reflect any newly enabled
        // optional columns whereas older months won't.
        const month = months.at(-1);
        const glob = `${ctx.dataDir}/aws/raw/${tier}-${String(month)}/*.parquet`;
        const rows = await ctx.db.runQuery(`DESCRIBE SELECT * FROM read_parquet('${glob}') LIMIT 0`);
        const cols = new Set<string>();
        for (const r of rows) {
          const name = r['column_name'];
          if (typeof name === 'string') cols.add(name);
        }
        return cols;
      } catch (err: unknown) {
        logger.warn(`column-probe: failed — ${err instanceof Error ? err.message : String(err)}`, { tier });
        return new Set<string>();
      }
    })();
    columnCache.set(tier, fetch);
    return fetch;
  }

  const queryLog = new QueryLog();
  const rollupStore = new RollupStore({ dataDir: ctx.dataDir, runQuery: (sql) => ctx.db.runQuery(sql) });
  const resultCache = new LRUCache<string, RawRow[]>(50);

  const wrappedRunQuery = queryLog.wrapQuery((sql, onStarted) => ctx.db.runQuery(sql, onStarted));
  const wrappedRunPreparedQuery = queryLog.wrapPreparedQuery((sql, params, onStarted) => ctx.db.runPreparedQuery(sql, params, onStarted));

  const inflightQueries = new Map<string, Promise<RawRow[]>>();

  function dedup(key: string, run: () => Promise<RawRow[]>): Promise<RawRow[]> {
    const existing = inflightQueries.get(key);
    if (existing !== undefined) return existing;
    const promise = run();
    inflightQueries.set(key, promise);
    void promise.finally(() => { inflightQueries.delete(key); });
    return promise;
  }

  const runQuery = (sql: string): Promise<RawRow[]> => {
    const cached = resultCache.get(sql);
    if (cached !== undefined) return Promise.resolve(cached);
    return dedup(sql, async () => {
      const result = await wrappedRunQuery(sql);
      if (result.length > 0) resultCache.set(sql, result);
      return result;
    });
  };

  const runPreparedQuery = (sql: string, params: readonly unknown[], materialized?: boolean): Promise<RawRow[]> => {
    const key = `${sql}\0${JSON.stringify(params)}`;
    const cached = resultCache.get(key);
    if (cached !== undefined) {
      const id = queryLog.start(sql, params, materialized === true);
      queryLog.markRunning(id);
      queryLog.complete(id, cached.length, true);
      return Promise.resolve(cached);
    }
    return dedup(key, async () => {
      const result = await wrappedRunPreparedQuery(sql, params, materialized);
      if (result.length > 0) resultCache.set(key, result);
      return result;
    });
  };

  // Full build-affecting shape signature for an arbitrary dimensions config.
  // The single source of truth for both the built rollup's signature (via
  // getRollupShape) and the what-if estimate's "does this grain match what's
  // built" check — keeping them on one code path so they can never drift (a
  // drift would silently make the estimate's matched-check always false).
  // computeShapeSignature ignores aliases/labels/region-enrichment, so the raw
  // editor `candidate` and the query-enriched dims hash identically for the same
  // enabled grain.
  async function signatureForDimensions(dimensions: DimensionsConfig): Promise<string> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const costScope = await getCostScope().catch(() => undefined);
    const availableColumns = await getAvailableColumns('daily');
    let orgRaw = '';
    try { orgRaw = await fs.readFile(path.join(path.dirname(ctx.dataDir), 'org-accounts.json'), 'utf-8'); } catch { /* no org sync yet */ }
    return computeShapeSignature({
      dimensions,
      costMetric: costScope?.costMetric ?? 'unblended',
      costPerspective: costScope?.costPerspective ?? 'gross',
      rules: costScope?.rules ?? [],
      marketplaceAttribution: costScope?.marketplaceAttribution,
      orgAccountsDigest: computeOrgAccountsDigest(orgRaw),
      availableColumns: [...availableColumns],
    });
  }

  async function getRollupShape(): Promise<RollupShape> {
    const dimensions = await getQueryDimensions();
    const signature = await signatureForDimensions(dimensions);
    const availableColumns = await getAvailableColumns('daily');
    return { signature, grainDimensions: rollupGrainColumns(dimensions), availableColumns: [...availableColumns] };
  }

  async function getEtagsByPeriod(): Promise<Record<string, Record<string, string>>> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    try {
      const raw = await fs.readFile(path.join(ctx.dataDir, getEtagFileName('daily')), 'utf-8');
      return parseEtagsJson(raw);
    } catch { return {}; }
  }

  async function buildRollupSqlFor(): Promise<BuildPartitionSql> {
    const dimensions = await getQueryDimensions();
    const orgPath = await getOrgAccountsPath();
    const accountReverseMap = await getAccountReverseMap();
    const costScope = await getCostScope().catch(() => undefined);
    const availableColumns = await getAvailableColumns('daily');
    return (period, outPath) => buildRollupPartitionQuery(period, 'daily', outPath, {
      dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, accountReverseMap, costScope, availableColumns,
    });
  }

  // Warm-load the persisted rollup: validate the manifest against the current
  // shape + raw etags (fast, sets readiness), then BACKGROUND-build any missing
  // or stale daily partitions (recent months first). Never blocks the app.
  async function warmupRollup(): Promise<void> {
    try {
      const shape = await getRollupShape();
      const etags = await getEtagsByPeriod();
      const validation = await rollupStore.loadAndValidate(shape, etags);
      const available = await listLocalMonths(ctx.dataDir, 'daily');
      const toBuild = available.filter(p => !validation.validPeriods.has(p)).sort((a, b) => b.localeCompare(a));
      if (toBuild.length === 0) { rollupStore.markSettled(); return; }
      const buildSql = await buildRollupSqlFor();
      void rollupStore.maintainPeriods(toBuild, buildSql, etags, shape).then(() => { resultCache.clear(); });
    } catch (err: unknown) {
      rollupStore.markSettled();
      logger.warn(`rollup-warmup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Re-roll only the periods a sync changed (file replace), then drop cached
  // results so dashboards re-render from the fresh partitions.
  async function maintainRollupForPeriods(changed: readonly string[]): Promise<void> {
    try {
      const available = await listLocalMonths(ctx.dataDir, 'daily');
      const periods = changed.filter(p => available.includes(p));
      if (periods.length === 0) return;
      const shape = await getRollupShape();
      const etags = await getEtagsByPeriod();
      if (!rollupStore.isReady()) await rollupStore.loadAndValidate(shape, etags);
      const buildSql = await buildRollupSqlFor();
      await rollupStore.maintainPeriods(periods, buildSql, etags, shape, { force: true });
      resultCache.clear();
    } catch (err: unknown) {
      logger.warn(`rollup-maintain: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let warmupInFlight: Promise<void> = Promise.resolve();
  function triggerWarmup(): void { warmupInFlight = warmupRollup().catch(() => undefined); }

  // A dimensions save always drops the rollup (so queries fall back to raw
  // immediately — correct) but the full re-roll is expensive. The dimensions
  // view autosaves on every toggle/reorder, so a burst of edits would otherwise
  // kick one full rebuild each. Coalesce the rebuild: invalidate right away,
  // debounce the warmup so a burst settles into a single re-roll.
  const ROLLUP_REROLL_DEBOUNCE_MS = 800;
  let rerollTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRollupReroll(): void {
    void rollupStore.invalidate().then(() => { resultCache.clear(); });
    if (rerollTimer !== null) clearTimeout(rerollTimer);
    rerollTimer = setTimeout(() => { rerollTimer = null; triggerWarmup(); }, ROLLUP_REROLL_DEBOUNCE_MS);
  }

  return {
    ctx,
    state,
    getConfig,
    getDimensions,
    getQueryDimensions,
    getOrgTreeConfig,
    getViews,
    getCostScope,
    getAccountMap,
    getAccountReverseMap,
    getRegionMap,
    getOrgAccountsPath,
    getAvailableColumns,
    signatureForDimensions,
    queryLog,
    rollupStore,
    runQuery,
    runPreparedQuery,
    invalidateConfig: () => { state.config = null; },
    invalidateDimensions: () => {
      state.dimensions = null; state.accountMap = null; state.accountReverseMap = null; state.regionMap = null; state.orgAccountsPath = null;
      // A dimensions change can alter the rollup grain/projection → drop the
      // persisted rollup and rebuild under the new shape-signature (debounced).
      scheduleRollupReroll();
    },
    invalidateViews: () => { state.views = null; },
    invalidateCostScope: () => {
      state.costScope = null;
      void rollupStore.invalidate().then(() => { resultCache.clear(); triggerWarmup(); });
    },
    invalidateColumnCache: () => { columnCache.clear(); },
    warmupBase: () => { resultCache.clear(); triggerWarmup(); },
    maintainRollup: (changedPeriods: readonly string[]) => { void maintainRollupForPeriods(changedPeriods); },
    awaitWarmup: async (timeoutMs: number): Promise<boolean> => {
      await awaitWithTimeout(warmupInFlight, timeoutMs);
      return rollupStore.isReady();
    },
    clearAllCaches: async (): Promise<void> => {
      ctx.db.cancelPendingQueries();
      state.config = null;
      state.dimensions = null;
      state.accountMap = null;
      state.accountReverseMap = null;
      state.regionMap = null;
      state.orgAccountsPath = null;
      state.views = null;
      state.costScope = null;
      columnCache.clear();
      inflightQueries.clear();
      await rollupStore.invalidate();
      resultCache.clear();
      triggerWarmup();
    },
  };
}

/** Read org-accounts.json and return an id→name map. When tagKey is set,
 *  each account's "name" is the value of that tag; accounts missing the tag
 *  fall back to the Name field. The OU Path sentinel routes to the
 *  account's `ouPath` field instead of `tags`. */
function resolveAccountName(acct: Record<string, unknown>, tagKey: string | undefined): string | undefined {
  if (tagKey === '__ouPath__') {
    const ouPath = acct['ouPath'];
    if (typeof ouPath === 'string' && ouPath.length > 0) return ouPath;
  } else if (tagKey !== undefined && tagKey.length > 0 && isStringRecord(acct['tags'])) {
    const tagVal = acct['tags'][tagKey];
    if (typeof tagVal === 'string' && tagVal.length > 0) return tagVal;
  }
  const name = acct['name'];
  if (typeof name === 'string' && name.length > 0) return name;
  return undefined;
}

export async function loadOrgAccountsMap(dataDir: string, tagKey?: string): Promise<Map<string, string>> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(path.dirname(dataDir), 'org-accounts.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStringRecord(parsed) || !Array.isArray(parsed['accounts'])) return map;
    for (const acct of parsed['accounts']) {
      if (!isStringRecord(acct)) continue;
      const id = acct['id'];
      if (typeof id !== 'string' || id.length === 0) continue;
      const resolved = resolveAccountName(acct, tagKey);
      if (resolved !== undefined) map.set(id, resolved);
    }
  } catch { /* no org sync */ }
  return map;
}

export async function prefsPath(dataDir: string, name: string): Promise<string> {
  const path = await import('node:path');
  return path.join(path.dirname(dataDir), `${name}.json`);
}

export function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === 'CredentialsProviderError' || name === 'TokenProviderError') return true;
  return err.message.includes('Token is expired') || err.message.includes('SSO session') || err.message.includes('credentials');
}

export function toUserFriendlyError(err: unknown, profile: string): Error {
  if (isCredentialError(err)) {
    return new Error(`AWS credentials expired for profile "${profile}". Run: aws sso login --profile ${profile}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
