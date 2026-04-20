import type { BuiltInDimension, CostGoblinConfig, DimensionsConfig, NormalizationRule, OrgNode, TagDimension } from './config.js';
import type { ViewsConfig } from './views.js';
import type { CostScopeCapabilities, CostScopeConfig, CostScopePreviewResult } from './cost-scope.js';
import type {
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerRowsParams,
  ExplorerRowsResult,
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
  getFilterValues(dimensionId: string, filters: Record<string, string>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }): Promise<{ value: string; label: string; count: number }[]>;
  deleteLocalPeriod(period: string, tier?: DataTier): Promise<void>;
  openDataFolder(): Promise<void>;
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
