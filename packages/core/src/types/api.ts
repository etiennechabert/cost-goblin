import type { BuiltInDimension, CostGoblinConfig, DimensionsConfig, NormalizationRule, OrgNode, TagDimension } from './config.js';
import type { AliasSuggestion } from '../normalize/similarity.js';
import type { ViewsConfig } from './views.js';
import type { CostScopeCapabilities, CostScopeConfig, CostScopePreviewResult } from './cost-scope.js';
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
}

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
  | { readonly state: 'idle'; readonly lastRun: string | null; readonly nextRun: string | null }
  | { readonly state: 'checking' }
  | { readonly state: 'syncing'; readonly tier: string; readonly filesDone: number; readonly filesTotal: number }
  | { readonly state: 'error'; readonly message: string; readonly lastRun: string | null };

export interface OrgSyncProgress {
  readonly phase: 'accounts' | 'ous' | 'tags' | 'regions';
  readonly done: number;
  readonly total: number;
}

export type Dimension = BuiltInDimension | TagDimension;

export type DataTier = 'daily' | 'hourly' | 'cost-optimization';

export interface DataInventoryResult {
  readonly periods: readonly {
    readonly period: string;
    readonly files: readonly { readonly key: string; readonly contentHash: string; readonly size: number }[];
    readonly totalSize: number;
    readonly localStatus: 'missing' | 'repartitioned' | 'stale';
  }[];
  readonly totalRemoteSize: number;
  readonly totalLocalPeriods: number;
  readonly totalRemotePeriods: number;
  readonly local: {
    readonly periods: readonly string[];
    readonly diskBytes: number;
    readonly oldestPeriod: string | null;
    readonly newestPeriod: string | null;
  };
}

export interface CostApi {
  queryCosts(params: CostQueryParams): Promise<CostResult>;
  queryDailyCosts(params: DailyCostsParams): Promise<DailyCostsResult>;
  queryTrends(params: TrendQueryParams): Promise<TrendResult>;
  queryMissingTags(params: MissingTagsParams): Promise<MissingTagsResult>;
  querySavings(): Promise<SavingsResult>;
  queryEntityDetail(params: EntityDetailParams): Promise<EntityDetailResult>;
  getSyncStatus(syncId?: string): Promise<SyncStatus>;
  getConfig(): Promise<CostGoblinConfig>;
  getDimensions(): Promise<Dimension[]>;
  getOrgTree(): Promise<OrgNode[]>;
  getDataInventory(tier?: DataTier): Promise<DataInventoryResult>;
  syncPeriods(files: readonly { key: string; contentHash: string; size: number }[], syncId?: string): Promise<{ filesDownloaded: number; rowsProcessed: number }>;
  cancelSync(syncId?: string): Promise<void>;
  getFilterValues(dimensionId: string, filters: Record<string, readonly string[]>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }, origin?: string): Promise<{ value: string; label: string; count: number }[]>;
  deleteLocalPeriod(period: string, tier?: DataTier): Promise<void>;
  openDataFolder(): Promise<void>;
  ssoLogin(profile: string): Promise<void>;
  getAccountMapping(): Promise<AccountMappingStatus>;
  getSetupStatus(): Promise<{ configured: boolean }>;
  testConnection(params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }>;
  listAwsProfiles(): Promise<string[]>;
  listS3Buckets(profile: string): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }>;
  browseS3(params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }>;
  scaffoldConfig(): Promise<void>;
  getSavingsPreferences(): Promise<SavingsPreferences>;
  saveSavingsPreferences(prefs: SavingsPreferences): Promise<void>;
  getUIPreferences(): Promise<UIPreferences>;
  saveUIPreferences(prefs: UIPreferences): Promise<void>;
  discoverTagKeys(): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }>;
  discoverColumnValues(field: string, opts?: { useOrgAccounts?: boolean; accountNameFromTag?: string; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule; useRegionNames?: boolean; dimName?: string }): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }>;
  getDimensionsConfig(): Promise<DimensionsConfig>;
  saveDimensionsConfig(config: DimensionsConfig): Promise<void>;
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
  /** Which optional CUR columns exist — drives UI warnings (e.g.
   *  degraded Amortized when effective-cost columns are missing). */
  getCostScopeCapabilities(): Promise<CostScopeCapabilities>;
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
  syncOrgAccounts(profile: string): Promise<OrgSyncResult>;
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
  writeConfig(config: {
    providerName: string;
    profile: string;
    dailyBucket: string;
    retentionDays?: number | undefined;
    hourlyBucket?: string | undefined;
    costOptBucket?: string | undefined;
    tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined;
  }): Promise<void>;
  /** Swap the AWS profile used to talk to AWS, leaving bucket paths and
   *  every other config field untouched. */
  updateAwsProfile(profile: string): Promise<void>;
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
   *  the daily CUR bucket, where teammates' setup wizards discover it;
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
  /** Resolve once the in-memory cost_base materialized table is ready (`true`)
   *  or the wait times out / no base is being built (`false`). The renderer
   *  awaits this before the startup dimension prewarm so those probes — and the
   *  first dashboard queries that follow — hit the in-memory base instead of
   *  racing the materialize with concurrent full raw-parquet scans. */
  awaitMaterializedBase(timeoutMs: number): Promise<boolean>;
  getMcpServerRunning(): Promise<boolean>;
  setMcpServerRunning(enabled: boolean): Promise<void>;
  /** The shared secret a client must send (as `Authorization: Bearer <token>`
   *  or a `?token=` query param) to reach the MCP server. */
  getMcpToken(): Promise<string>;
  /** Rotate the MCP token, restarting the server if running. Returns the new
   *  token. Existing clients must update their config to keep working. */
  regenerateMcpToken(): Promise<string>;
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
  onStatusChanged(callback: (status: UpdateStatus) => void): () => void;
  getAppVersion(): Promise<string>;
}
