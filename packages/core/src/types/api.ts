import type { BuiltInDimension, CostGoblinConfig, DimensionsConfig, NormalizationRule, OrgNode, TagDimension } from './config.js';
import type {
  BaselineCreateInput,
  BaselineDetail,
  BaselineDriftRow,
  BaselineRecomputeStatus,
  BaselineRecord,
  BaselineSnapshot,
  BaselinesConfigState,
  BaselinesDiscoveryConfig,
  BaselinesListParams,
  BaselinesListResult,
  BaselineUpdatePatch,
} from './baseline.js';
import type { RollupGrainEstimate } from '../rollup/estimator.js';
import type { AliasSuggestion } from '../normalize/similarity.js';
import type { ViewsConfig } from './views.js';
import type { CostScopeConfig, CostScopePreviewResult } from './cost-scope.js';
import type { TelemetryPreferences, TelemetryStatus, TelemetryOutboxEntry } from '../telemetry/types.js';
import type {
  ApplyConfigBundleParams,
  ApplyConfigBundleResult,
  CheckConfigBeaconParams,
  CheckConfigBeaconResult,
  DataSharingResult,
  DataSharingStatus,
  ExportConfigBundleResult,
  PreviewConfigBundleResult,
  PreviewSharedSourceResult,
  PublishConfigBundleResult,
  PullSharedSourceResult,
  SharedPullProgress,
  SharedPullSelection,
  SharedSourceInfo,
} from './sharing.js';
import type {
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerRowsParams,
  ExplorerRowsResult,
  AggregatedTableParams,
  AggregatedTableResult,
} from './explorer.js';
import type {
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  EntityDetailParams,
  EntityDetailResult,
  MissingTagsParams,
  MissingTagsResult,
  SavingsResult,
  SyncStatus,
  SyncLogLine,
  SyncLogLevel,
  TrendQueryParams,
  TrendResult,
} from './query.js';

export interface SavingsPreferences {
  readonly hiddenActionTypes: readonly string[];
}

export interface UIPreferences {
  readonly theme: 'dark' | 'light';
  readonly palette: 'standard' | 'colorblind';
  readonly defaultViewId?: string | undefined;
  readonly performance?: PerformanceSettings | undefined;
}

/** User overrides for DuckDB resource tuning. `null` means "auto" — use the
 *  default (machine-derived for memory/threads; a fixed 2 for rollupConcurrency). */
export interface PerformanceSettings {
  readonly memoryLimitGB: number | null;
  readonly threads: number | null;
  /** Max monthly rollup partitions built in parallel. null = default (2). Kept
   *  low so a rebuild doesn't starve the cores that keep the UI responsive. */
  readonly rollupConcurrency: number | null;
}

/** Performance tuning context for the settings UI: the machine-derived defaults
 *  and valid ranges, plus the user's current overrides. */
export interface PerformanceInfo {
  readonly defaultMemoryGB: number;
  readonly defaultThreads: number;
  readonly defaultRollupConcurrency: number;
  readonly totalMemoryGB: number;
  readonly maxThreads: number;
  readonly maxRollupConcurrency: number;
  readonly minMemoryGB: number;
  readonly maxMemoryGB: number;
  readonly current: PerformanceSettings;
}

export interface WorkspaceSummary {
  readonly name: string;
  readonly active: boolean;
  /** Whether setup has completed (the workspace's costgoblin.yaml exists). */
  readonly configured: boolean;
  /** Recursive on-disk size; null when it couldn't be computed. */
  readonly sizeBytes: number | null;
  readonly lastUsedAt: string | null;
}

export interface WorkspacesInfo {
  /** 'pinned' when COSTGOBLIN_DATA_DIR/COSTGOBLIN_CONFIG_DIR pin the paths
   *  (dev/e2e) — workspace management is unavailable and the list is empty. */
  readonly mode: 'pinned' | 'workspace';
  readonly active: string | null;
  readonly workspaces: readonly WorkspaceSummary[];
}

export type CreateWorkspaceSource =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'copy-config' }
  | { readonly kind: 'bundle'; readonly content: string; readonly awsProfile: string };

export interface OrgAccount {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly joinedTimestamp: string;
  readonly ouPath: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface OrgSyncResult {
  readonly accounts: readonly OrgAccount[];
  readonly orgId: string;
  readonly syncedAt: string;
}

export type AutoSyncStatus =
  | { readonly state: 'disabled' }
  | { readonly state: 'idle'; readonly lastRun: string | null; readonly nextRun: string | null; readonly providerErrors?: readonly ProviderSyncError[] | undefined }
  | { readonly state: 'checking'; readonly provider?: string | undefined }
  | { readonly state: 'syncing'; readonly tier: string; readonly filesDone: number; readonly filesTotal: number; readonly provider?: string | undefined }
  | { readonly state: 'error'; readonly message: string; readonly lastRun: string | null; readonly providerErrors?: readonly ProviderSyncError[] | undefined };

/** One provider's failure inside an auto-sync pass. Providers sync
 *  independently — one expired SSO session must not hide the others'
 *  results, so per-provider errors are collected instead of aborting. */
export interface ProviderSyncError {
  readonly provider: string;
  readonly message: string;
}

export interface OrgSyncProgress {
  readonly phase: 'accounts' | 'ous' | 'tags' | 'regions';
  readonly done: number;
  readonly total: number;
}

export type Dimension = BuiltInDimension | TagDimension;

export type DataTier = 'daily' | 'hourly' | 'cost-optimization';

export interface DataInventoryResult {
  /** Which configured provider this inventory describes. */
  readonly provider?: string | undefined;
  readonly periods: readonly {
    readonly period: string;
    readonly files: readonly { readonly key: string; readonly contentHash: string; readonly size: number }[];
    readonly totalSize: number;
    readonly localStatus: 'missing' | 'repartitioned' | 'stale';
  }[];
  readonly totalRemoteSize: number;
  readonly totalLocalPeriods: number;
  readonly totalRemotePeriods: number;
  /** ISO 8601 of the last successful sync for this tier, or null if never
   *  synced (imported-only or fresh). Durable across app restarts. */
  readonly lastSync: string | null;
  readonly local: {
    readonly periods: readonly string[];
    readonly diskBytes: number;
    readonly oldestPeriod: string | null;
    readonly newestPeriod: string | null;
  };
}

export interface PruneResult {
  readonly deleted: readonly { readonly tier: DataTier; readonly period: string; readonly provider?: string | undefined }[];
}

export interface CostApi {
  queryCosts(params: CostQueryParams): Promise<CostResult>;
  queryDailyCosts(params: DailyCostsParams): Promise<DailyCostsResult>;
  queryTrends(params: TrendQueryParams): Promise<TrendResult>;
  queryMissingTags(params: MissingTagsParams): Promise<MissingTagsResult>;
  querySavings(): Promise<SavingsResult>;
  queryEntityDetail(params: EntityDetailParams): Promise<EntityDetailResult>;
  /** `syncId` addresses one (provider, tier) sync: `'{providerName}:{tier}'`.
   *  The legacy tier-only ids ('default'|'hourly'|'cost-optimization') are
   *  still accepted and resolve against the first configured provider. */
  getSyncStatus(syncId?: string): Promise<SyncStatus>;
  /** Current backlog of the live sync/S3 activity log (main-process ring
   *  buffer, ephemeral — cleared on app restart). */
  getSyncLog(): Promise<readonly SyncLogLine[]>;
  /** Subscribe to new sync/S3 log lines as they're appended. Returns an
   *  unsubscribe fn. Pushed via IPC, so no polling. */
  subscribeSyncLog(listener: (line: SyncLogLine) => void): () => void;
  /** Append a renderer-originated line to the sync/S3 activity log — used by
   *  on-demand actions (manual Sync/Prune) to narrate the S3 check, which
   *  otherwise runs silently when there's nothing to download. */
  appendSyncLog(level: SyncLogLevel, message: string): Promise<void>;
  /** Empty the sync/S3 activity log ring buffer. */
  clearSyncLog(): Promise<void>;
  getConfig(): Promise<CostGoblinConfig>;
  getDimensions(): Promise<Dimension[]>;
  getOrgTree(): Promise<OrgNode[]>;
  /** Inventory for one provider's tier. `providerName` defaults to the
   *  first configured provider. */
  getDataInventory(tier?: DataTier, providerName?: string): Promise<DataInventoryResult>;
  syncPeriods(files: readonly { key: string; contentHash: string; size: number }[], syncId?: string): Promise<{ filesDownloaded: number; rowsProcessed: number }>;
  cancelSync(syncId?: string): Promise<void>;
  getFilterValues(dimensionId: string, filters: Record<string, readonly string[]>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }, origin?: string): Promise<{ value: string; label: string; count: number }[]>;
  deleteLocalPeriod(period: string, tier?: DataTier, providerName?: string): Promise<void>;
  openDataFolder(): Promise<void>;
  ssoLogin(profile: string): Promise<void>;
  /** Establish GCP Application Default Credentials by spawning
   *  `gcloud auth application-default login`. Takes no profile: ADC is a
   *  single machine-wide credential, which is why this is its own method
   *  rather than an argument on `ssoLogin`. Rejects with a message
   *  containing `GCLOUD_CLI_NOT_FOUND` when the CLI is not installed. */
  gcloudLogin(): Promise<void>;
  getAccountMapping(): Promise<AccountMappingStatus>;
  /** `postSetup` is true only on the launch immediately following the setup
   *  wizard (carried across the wizard's relaunch), so the UI can land the user
   *  on the data-sync screen instead of an empty dashboard. */
  getSetupStatus(): Promise<{ configured: boolean; postSetup: boolean }>;
  testConnection(params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }>;
  listAwsProfiles(): Promise<string[]>;
  listS3Buckets(profile: string): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }>;
  browseS3(params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isBillingExport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'cur-legacy' | 'unknown'; missingColumns: string[] }>;
  scaffoldConfig(): Promise<void>;
  getSavingsPreferences(): Promise<SavingsPreferences>;
  saveSavingsPreferences(prefs: SavingsPreferences): Promise<void>;
  getUIPreferences(): Promise<UIPreferences>;
  saveUIPreferences(prefs: UIPreferences): Promise<void>;
  discoverTagKeys(): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }>;
  discoverColumnValues(field: string, opts?: { useOrgAccounts?: boolean; accountNameFromTag?: string; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule; useRegionNames?: boolean; dimName?: string }): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }>;
  getDimensionsConfig(): Promise<DimensionsConfig>;
  saveDimensionsConfig(config: DimensionsConfig): Promise<void>;
  /** Estimate the rollup cost/benefit of a candidate dimensions config before
   *  committing the (background) re-roll: directional size/compression/rebuild
   *  bands plus per-dimension raw-only flags (rollup design §8). Probes a recent
   *  month, so it needs data on disk — returns an empty estimate otherwise. */
  estimateRollupGrain(candidate: DimensionsConfig): Promise<RollupGrainEstimate>;
  /** User-defined dashboard views. Read-modify-write through `saveViewsConfig`.
   *  `resetViewsConfig` overwrites the file with the seed (Cost Overview) view. */
  getViewsConfig(): Promise<ViewsConfig>;
  saveViewsConfig(config: ViewsConfig): Promise<void>;
  resetViewsConfig(): Promise<ViewsConfig>;
  /** Reveal `views.yaml` in the OS file manager (Finder / Explorer). */
  revealViewsFolder(): Promise<void>;
  getCostScope(): Promise<CostScopeConfig>;
  saveCostScope(config: CostScopeConfig): Promise<void>;
  previewCostScope(config: CostScopeConfig): Promise<CostScopePreviewResult>;
  revealCostScopeFolder(): Promise<void>;
  /** Daily histogram + aggregate totals for the Explorer. Independent of
   *  sort so the histogram doesn't re-fetch when the user reorders a
   *  column. */
  queryExplorerOverview(params: ExplorerOverviewParams): Promise<ExplorerOverviewResult>;
  /** Top-|cost| sample rows under the explorer's filters + sort. Only
   *  fires when sort / filters / range / scope changes — the overview
   *  query handles the histogram independently. */
  queryExplorerRows(params: ExplorerRowsParams): Promise<ExplorerRowsResult>;
  queryAggregatedTable(params: AggregatedTableParams): Promise<AggregatedTableResult>;
  /** Facet values for a single dim under the explorer's other filters.
   *  Rolls the current dim out of the filter set so the dropdown shows
   *  every value remaining under the other filters. */
  getExplorerFilterValues(params: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]>;
  getExplorerPreferences(): Promise<ExplorerPreferences>;
  saveExplorerPreferences(prefs: ExplorerPreferences): Promise<void>;
  getAutoSyncEnabled(): Promise<boolean>;
  setAutoSyncEnabled(enabled: boolean): Promise<void>;
  /** Minimum minutes between auto-sync runs. Default: 24 × 60 (one day).
   *  Clamped server-side to [60, 7×24×60]. */
  getAutoSyncIntervalMinutes(): Promise<number>;
  setAutoSyncIntervalMinutes(minutes: number): Promise<void>;
  getAutoSyncStatus(): Promise<AutoSyncStatus>;
  /** Whether the scheduler automatically prunes out-of-retention local data on
   *  each run. Off by default. Shares the auto-sync scheduler — enabling it
   *  starts the scheduler even when auto-download is off. */
  getAutoPruneEnabled(): Promise<boolean>;
  setAutoPruneEnabled(enabled: boolean): Promise<void>;
  /** Delete every local billing period that has fallen outside its tier's
   *  retention window, across all configured tiers. Returns what was removed.
   *  Local-only — no S3 access required. */
  pruneNow(): Promise<PruneResult>;
  /** Runs the AWS Organizations side sync with `profile`'s credentials and
   *  stores the result under `providerName` (defaults to the first
   *  configured provider). Results from every provider are merged into the
   *  account-name/tag lookups the queries consume. */
  syncOrgAccounts(profile: string, providerName?: string): Promise<OrgSyncResult>;
  getOrgSyncResult(): Promise<OrgSyncResult | null>;
  getOrgSyncProgress(): Promise<OrgSyncProgress | null>;
  /** Region-name cache info (count of resolved long-names + last sync time +
   *  the full per-region metadata map so the UI can display it in an expanded
   *  view and surface extra dimensions like country/continent).
   *  Populated as a side-effect of syncOrgAccounts. Returns null when no
   *  sync has ever been attempted; when the SSM step failed, returns
   *  count=0 with lastError set so the UI can explain why. */
  getRegionNamesInfo(): Promise<{ count: number; syncedAt: string; lastError: string | null; regions: Record<string, { longName: string; country: string; continent: string }> } | null>;
  /** Delete every file produced by the AWS Org sync (accounts, account-tag
   *  lookup, region-name cache). Idempotent. */
  clearOrgData(): Promise<void>;
  /** Re-fetch only the SSM region-name cache, without re-running the slow
   *  per-account org sync. Surfaces errors directly to the caller. */
  syncRegionNames(profile: string): Promise<{ count: number; syncedAt: string }>;

  /** Create or update the provider named `providerName` (UPSERT — other
   *  configured providers are preserved). */
  writeConfig(config: {
    providerName: string;
    /** Provider arm to write. Omitted means `'aws'`, so pre-#517 callers
     *  keep their behaviour. `profile` is read only by the aws arm and
     *  `keyFile` only by the gcp one; `costOptBucket` is ignored for gcp,
     *  which has no Cost Optimization Hub analogue. */
    type?: 'aws' | 'gcp' | undefined;
    profile: string;
    keyFile?: string | undefined;
    dailyBucket: string;
    retentionDays?: number | undefined;
    hourlyBucket?: string | undefined;
    costOptBucket?: string | undefined;
    tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined;
  }): Promise<void>;
  /** Swap the AWS credentials profile of one provider (default: the first),
   *  leaving bucket paths and every other config field untouched. */
  updateAwsProfile(profile: string, providerName?: string): Promise<void>;
  /** Remove a provider from the config by exact name. Its on-disk data tree
   *  is left in place (never a data-loss operation); rejects removing the
   *  last remaining provider. */
  removeProvider(providerName: string): Promise<void>;
  getAliasSuggestions(tagName: string): Promise<AliasSuggestion[]>;
  dismissSuggestion(tagName: string, canonical: string, aliases: readonly string[]): Promise<void>;
  acceptSuggestion(tagName: string, canonical: string, aliases: readonly string[]): Promise<void>;
  /** Cancel all queued (not yet running) DuckDB queries. Call on view
   *  navigation so stale queries from the previous view don't hold pool
   *  connections and slow down the new view's queries. */
  /** Export the org-shared config (providers minus credentials, dimensions,
   *  org tree, cost scope, views) as a single bundle file via a save
   *  dialog. */
  exportConfigBundle(): Promise<ExportConfigBundleResult>;
  /** Open-dialog + parse + validate a bundle file. Returns the raw content
   *  alongside the summary — the renderer hands the content back to
   *  `applyConfigBundle`, which re-validates in the main process. */
  previewConfigBundleFile(): Promise<PreviewConfigBundleResult>;
  /** Fetch + parse + validate a bundle from an explicit S3 location (the
   *  import dialog's "fetch from S3" source). Unlike `checkConfigBeacon`,
   *  failures are reported, never swallowed. */
  fetchConfigBundleFromS3(params: { profile: string; location: string }): Promise<PreviewConfigBundleResult>;
  /** Validate and write a bundle to the config directory. Existing config
   *  files are copied to a timestamped backup folder first. The chosen AWS
   *  profile is injected into every imported provider. */
  applyConfigBundle(params: ApplyConfigBundleParams): Promise<ApplyConfigBundleResult>;
  /** Publish the current config as a bundle to S3. Defaults to the
   *  well-known beacon key (`costgoblin/org-config.yaml`) at the root of
   *  the daily billing-export bucket, where teammates' setup wizards discover it;
   *  `location` overrides the destination (custom keys publish fine but
   *  are not auto-discovered). `profile` overrides the AWS profile for
   *  just this action (publishing needs s3:PutObject, which day-to-day
   *  read-only profiles often lack); defaults to the configured sync
   *  profile. */
  publishConfigBundle(params?: { location?: string | undefined; profile?: string | undefined }): Promise<PublishConfigBundleResult>;
  /** Probe a bucket for a published team configuration. Used by the setup
   *  wizard right after bucket selection. */
  checkConfigBeacon(params: CheckConfigBeaconParams): Promise<CheckConfigBeaconResult>;
  // --- Peer data sharing (LAN, TLS-PSK) ---
  /** Publisher: current sharing state, including the sharing key while on. */
  getDataSharingStatus(): Promise<DataSharingStatus>;
  /** Publisher: start sharing this machine's data on the local network. */
  enableDataSharing(): Promise<DataSharingResult>;
  /** Publisher: stop sharing. */
  disableDataSharing(): Promise<DataSharingResult>;
  /** Publisher: rotate the access secret (revokes outstanding keys) and
   *  return a fresh sharing key. */
  rotateDataSharingKey(): Promise<DataSharingResult>;
  /** Consumer: fetch + verify a teammate's manifest WITHOUT downloading data,
   *  so the UI can show which tiers/months are on offer before committing. */
  previewSharedSource(key: string): Promise<PreviewSharedSourceResult>;
  /** Consumer: same preview, but for the already-saved source (the key stays
   *  in the main process — used by the "reconnect" affordance). */
  previewStoredSource(): Promise<PreviewSharedSourceResult>;
  /** Consumer: connect with a pasted sharing key, pull the snapshot over the
   *  encrypted channel, verify it, and import data + config locally. `selection`
   *  limits which tiers/periods are pulled; omit to pull everything. */
  addSharedSource(key: string, selection?: SharedPullSelection): Promise<PullSharedSourceResult>;
  /** Consumer: the configured shared source, or null if none. */
  getSharedSource(): Promise<SharedSourceInfo | null>;
  /** Consumer: live progress of an in-flight pull (polled by the UI). */
  getSharedPullProgress(): Promise<SharedPullProgress>;
  /** Consumer: re-pull from the configured source. `selection` overrides the
   *  stored choice; omit to reuse what was last pulled. */
  refreshSharedSource(selection?: SharedPullSelection): Promise<PullSharedSourceResult>;
  /** Consumer: forget the configured source (local data is left in place). */
  removeSharedSource(): Promise<void>;
  cancelPendingQueries(): Promise<void>;
  /** Wipe every backend cache (LRU result cache, column probe cache,
   *  in-flight de-dup map, materialized base table, plus the in-memory
   *  config/dimensions/views snapshots). The base table is re-warmed in
   *  the background. The renderer should follow up with its own view
   *  refresh so the user sees fresh data. */
  clearAllCaches(): Promise<void>;
  /** Machine-derived DuckDB tuning defaults + ranges + the user's current
   *  overrides, for the performance settings UI. */
  getPerformanceInfo(): Promise<PerformanceInfo>;
  /** Persist DuckDB tuning overrides (null = auto) and apply them live. */
  setPerformanceSettings(perf: PerformanceSettings): Promise<void>;
  /** Resolve once the in-memory cost_base materialized table is ready (`true`)
   *  or the wait times out / no base is being built (`false`). The renderer
   *  awaits this before the startup dimension prewarm so those probes — and the
   *  first dashboard queries that follow — hit the in-memory base instead of
   *  racing the materialize with concurrent full raw-parquet scans. */
  awaitMaterializedBase(timeoutMs: number): Promise<boolean>;
  // --- Cost Baselines ---
  /** List baselines with filter/sort/paging; returns items plus the summed
   *  potential/realized over the filtered discovered partition. */
  listBaselines(params: BaselinesListParams): Promise<BaselinesListResult>;
  /** Full detail (record + stored daily history + snapshots) for one baseline. */
  getBaseline(id: string): Promise<BaselineDetail | null>;
  /** Pin a baseline for a scope. Rejects a duplicate normalized scope+basis. */
  createBaseline(input: BaselineCreateInput): Promise<BaselineRecord>;
  /** Atomic update: band edit + status change + note, with auto-summary. */
  updateBaseline(id: string, patch: BaselineUpdatePatch): Promise<BaselineRecord | null>;
  deleteBaseline(id: string): Promise<void>;
  /** Re-discover + recompute all baselines. `startFresh` wipes every discovered
   *  baseline (incl. user-edited) before re-discovering; otherwise untouched
   *  orphans are pruned and edited ones preserved. */
  recomputeBaselines(opts?: { readonly startFresh?: boolean }): Promise<void>;
  /** Point-in-time snapshot history for a baseline (for trend analysis). */
  getBaselineSnapshots(id: string): Promise<readonly BaselineSnapshot[]>;
  /** "What changed" breakdown: contribution by a child dimension, trailing vs
   *  band window. */
  getBaselineDrift(id: string, childDimension: string): Promise<readonly BaselineDriftRow[]>;
  getBaselinesConfig(): Promise<BaselinesConfigState>;
  setBaselinesConfig(config: BaselinesDiscoveryConfig): Promise<BaselinesConfigState>;
  resetBaselinesConfig(): Promise<BaselinesConfigState>;
  getMcpServerRunning(): Promise<boolean>;
  setMcpServerRunning(enabled: boolean): Promise<void>;
  /** The shared secret a client must send (as `Authorization: Bearer <token>`
   *  or a `?token=` query param) to reach the MCP server. */
  getMcpToken(): Promise<string>;
  /** Rotate the MCP token, restarting the server if running. Returns the new
   *  token. Existing clients must update their config to keep working. */
  regenerateMcpToken(): Promise<string>;
  /** Opt-in telemetry channel preferences (all default OFF). */
  getTelemetryPreferences(): Promise<TelemetryPreferences>;
  /** Persist telemetry channel preferences and apply them live — enabling a
   *  channel lazily initialises the Sentry SDK, disabling all of them flushes
   *  and shuts it down. */
  setTelemetryPreferences(prefs: TelemetryPreferences): Promise<void>;
  /** Whether a DSN is configured and whether the SDK is active this session,
   *  so the UI can explain why nothing is (or is) being sent. */
  getTelemetryStatus(): Promise<TelemetryStatus>;
  /** The local telemetry audit log — one entry per event handed to the
   *  transport — so the user can see exactly what left the machine. Most
   *  recent first. */
  getTelemetryOutbox(): Promise<readonly TelemetryOutboxEntry[]>;
  // --- Workspaces ---
  /** Enumerate workspaces and which one is active. */
  getWorkspaces(): Promise<WorkspacesInfo>;
  /** Create a workspace from the given source. `switchTo` relaunches into it
   *  on success (the promise then never settles meaningfully). */
  createWorkspace(name: string, source: CreateWorkspaceSource, switchTo: boolean): Promise<WorkspacesInfo>;
  /** Rename a workspace. Renaming the active one relaunches the app. */
  renameWorkspace(from: string, to: string): Promise<WorkspacesInfo>;
  /** Delete a workspace and ALL its synced data/config. Rejects the active
   *  workspace and the last remaining one. */
  deleteWorkspace(name: string): Promise<WorkspacesInfo>;
  /** Persist the workspace as last-used and relaunch into it. */
  switchWorkspace(name: string): Promise<void>;
  /** Finish the setup wizard: optionally claim a name for the initial
   *  'default' workspace (renamed just before restart), then relaunch with
   *  the post-setup flag. Pass null to keep the current name. */
  completeSetup(workspaceName: string | null): Promise<void>;
}

export interface AccountMappingEntry {
  readonly accountId: string;
  readonly name: string;
  readonly orgPath: string;
  readonly email: string;
  readonly state: string;
}

export type AccountMappingStatus =
  | { readonly status: 'found'; readonly accounts: readonly AccountMappingEntry[]; readonly path: string }
  | { readonly status: 'missing' };

export interface UpdateInfo {
  readonly version: string;
  readonly releaseDate: string;
  readonly releaseNotes: string | null;
}

export type UpdateStage = 'check' | 'download' | 'install';

export interface UpdateLogEntry {
  readonly timestamp: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

export type UpdateStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'available'; readonly info: UpdateInfo }
  | { readonly state: 'downloading'; readonly percent: number; readonly info: UpdateInfo }
  | { readonly state: 'downloaded'; readonly info: UpdateInfo }
  | {
      readonly state: 'error';
      readonly error: string;
      readonly stage: UpdateStage;
      readonly logs: readonly UpdateLogEntry[];
    };

export interface UpdateApi {
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
  /** Relaunch the app (not an update) — used to apply a telemetry consent
   *  change, which can only take effect at startup. Pass `postSetup` when
   *  relaunching at the end of the setup wizard so the next launch can resume on
   *  the data-sync screen. */
  relaunch(postSetup?: boolean): void;
  onStatusChanged(callback: (status: UpdateStatus) => void): () => void;
  getAppVersion(): Promise<string>;
}

/** Live state of the on-disk daily rollup. Pushed to the renderer so the header
 *  can show whether dashboards are currently served from the pre-aggregated
 *  rollup (`ready`) or transiently from the slower raw path while a re-roll runs
 *  (`computing`) — e.g. after a dimensions save or a sync. `idle` = no rollup
 *  built yet (no local data); `failed` = the last build batch hit an error.
 *  `message` is the count summary ("N of M partitions failed"); `reason` is the
 *  underlying error (the DuckDB/IO message the build threw) so the user can tell
 *  *why* it failed without digging through logs. While `computing`, `periods`
 *  lists every month completed-first (the first `done` are built) and `active` is
 *  the subset whose build is in flight right now, so the popover can pulse those
 *  chips. */
export type RollupStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'computing'; readonly done: number; readonly total: number; readonly periods: readonly string[]; readonly active: readonly string[] }
  | { readonly state: 'ready'; readonly periods: number }
  | { readonly state: 'failed'; readonly message: string; readonly reason: string; readonly periods: number };

/** Size KPIs for the built rollup vs the raw daily Parquet it's derived from.
 *  `rawBytes` is read from the local filesystem (no S3), so it's available even
 *  without AWS credentials. Null when no rollup is built. */
export interface RollupStats {
  readonly months: number;
  readonly rollupRows: number;
  readonly rollupBytes: number;
  readonly rawBytes: number;
}

export interface RollupApi {
  getStatus(): Promise<RollupStatus>;
  getStats(): Promise<RollupStats | null>;
  onStatusChanged(callback: (status: RollupStatus) => void): () => void;
}

/** Push channel for live baseline recompute/discovery status — model of the
 *  rollup/update status channels. Exposed as `window.costgoblinBaselines`. */
export interface BaselinesApi {
  getStatus(): Promise<BaselineRecomputeStatus>;
  onStatusChanged(callback: (status: BaselineRecomputeStatus) => void): () => void;
}
