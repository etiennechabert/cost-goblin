import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  CostApi,
  Dimension,
  CostGoblinConfig,
  OrgNode,
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  TrendQueryParams,
  TrendResult,
  MissingTagsParams,
  MissingTagsResult,
  EntityDetailParams,
  EntityDetailResult,
  SyncStatus,
  SavingsResult,
  DataInventoryResult,
  DataTier,
  AccountMappingStatus,
  SavingsPreferences,
  UIPreferences,
  DimensionsConfig,
  NormalizationRule,
  OrgSyncResult,
  OrgSyncProgress,
  AutoSyncStatus,
  ViewsConfig,
  CostScopeCapabilities,
  CostScopeConfig,
  CostScopePreviewResult,
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerRowsParams,
  ExplorerRowsResult,
  AggregatedTableParams,
  AggregatedTableResult,
  AliasSuggestion,
  ApplyConfigBundleParams,
  ApplyConfigBundleResult,
  CheckConfigBeaconParams,
  CheckConfigBeaconResult,
  ExportConfigBundleResult,
  PreviewConfigBundleResult,
  PublishConfigBundleResult,
} from '@costgoblin/core/browser';

// ---------------------------------------------------------------------------
// invoke wrapper — mirrors Electron preload's in-flight counter so the app's
// debug badge (costgoblinDebug.getInFlightCount, a SYNC call) keeps working.
// ---------------------------------------------------------------------------
let inFlightCount = 0;

function invoke<T>(cmd: string, params?: unknown): Promise<T> {
  inFlightCount++;
  const args = params === undefined ? undefined : { params };
  return tauriInvoke<T>(cmd, args).finally(() => {
    inFlightCount--;
  });
}

// Debug/diagnostic calls — do NOT inflate the in-flight badge (matches the
// Electron preload, which excludes `debug:` channels).
function invokeRaw<T>(cmd: string, params?: unknown): Promise<T> {
  const args = params === undefined ? undefined : { params };
  return tauriInvoke<T>(cmd, args);
}

function ok<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

// ---------------------------------------------------------------------------
// CostApi — read methods hit Rust commands (real DuckDB queries over the
// fixture Parquet). The AWS / sync / sharing / org / MCP / update surface is
// stubbed with valid shapes so the renderer boots and navigates without the
// real cloud backend. This is the spike boundary: everything analytical is
// real; everything that would mutate cloud/AWS state is inert.
// ---------------------------------------------------------------------------
const api: CostApi = {
  // ---- Real reads (Rust + DuckDB over fixtures) ----
  queryCosts: (params: CostQueryParams): Promise<CostResult> => invoke('query_costs', params),
  queryDailyCosts: (params: DailyCostsParams): Promise<DailyCostsResult> => invoke('query_daily_costs', params),
  queryTrends: (params: TrendQueryParams): Promise<TrendResult> => invoke('query_trends', params),
  queryMissingTags: (params: MissingTagsParams): Promise<MissingTagsResult> => invoke('query_missing_tags', params),
  queryEntityDetail: (params: EntityDetailParams): Promise<EntityDetailResult> => invoke('query_entity_detail', params),
  getConfig: (): Promise<CostGoblinConfig> => invoke('get_config'),
  getDimensions: (): Promise<Dimension[]> => invoke('get_dimensions'),
  getDimensionsConfig: (): Promise<DimensionsConfig> => invoke('get_dimensions_config'),
  getOrgTree: (): Promise<OrgNode[]> => invoke('get_org_tree'),
  getViewsConfig: (): Promise<ViewsConfig> => invoke('get_views_config'),
  getCostScope: (): Promise<CostScopeConfig> => invoke('get_cost_scope'),
  getDataInventory: (tier?: DataTier): Promise<DataInventoryResult> => invoke('get_data_inventory', { tier }),
  getUIPreferences: (): Promise<UIPreferences> => invoke('get_ui_preferences'),
  getExplorerPreferences: (): Promise<ExplorerPreferences> => invoke('get_explorer_preferences'),
  getFilterValues: (
    dimensionId: string,
    filters: Record<string, readonly string[]>,
    dateRange?: { start: string; end: string },
    opts?: { bypassCostScope?: boolean },
    origin?: string,
  ): Promise<{ value: string; label: string; count: number }[]> =>
    invoke('get_filter_values', { dimensionId, filters, dateRange, opts, origin }),
  queryExplorerOverview: (params: ExplorerOverviewParams): Promise<ExplorerOverviewResult> => invoke('query_explorer_overview', params),
  queryExplorerRows: (params: ExplorerRowsParams): Promise<ExplorerRowsResult> => invoke('query_explorer_rows', params),
  queryAggregatedTable: (params: AggregatedTableParams): Promise<AggregatedTableResult> => invoke('query_aggregated_table', params),
  getExplorerFilterValues: (params: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]> => invoke('get_explorer_filter_values', params),
  discoverTagKeys: (): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> =>
    invoke('discover_tag_keys'),
  discoverColumnValues: (
    field: string,
    opts?: { useOrgAccounts?: boolean; accountNameFromTag?: string; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule; useRegionNames?: boolean; dimName?: string },
  ): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }> =>
    invoke('discover_column_values', { field, opts }),

  // ---- Stubbed: configured, but cloud/cost-optimization data is absent ----
  getSetupStatus: (): Promise<{ configured: boolean }> => ok({ configured: true }),
  getSyncStatus: (): Promise<SyncStatus> => ok({ status: 'idle', lastSync: null }),
  querySavings: (): Promise<SavingsResult> => invoke('query_savings'),
  getAccountMapping: (): Promise<AccountMappingStatus> => ok({ status: 'missing' }),
  getSavingsPreferences: (): Promise<SavingsPreferences> => ok({ hiddenActionTypes: [] }),
  getCostScopeCapabilities: (): Promise<CostScopeCapabilities> => ok({ hasEffectiveCostColumns: false, hasNetColumns: false, hasListPriceColumn: true }),
  previewCostScope: (_config: CostScopeConfig): Promise<CostScopePreviewResult> => ok({
    windowDays: 0, startDate: '', endDate: '', perRule: [],
    combined: { excludedCost: 0, excludedRows: 0 },
    unscopedTotalCost: 0, scopedTotalCost: 0, dailyTotals: [], sampleRows: [],
    sampleTotalRowCount: 0, tagColumns: [],
  }),

  // ---- Stubbed writes / no-ops (config edits are in-memory for the spike) ----
  saveUIPreferences: (): Promise<void> => ok(undefined),
  saveSavingsPreferences: (): Promise<void> => ok(undefined),
  saveExplorerPreferences: (): Promise<void> => ok(undefined),
  saveDimensionsConfig: (): Promise<void> => ok(undefined),
  saveViewsConfig: (): Promise<void> => ok(undefined),
  resetViewsConfig: (): Promise<ViewsConfig> => invoke('get_views_config'),
  revealViewsFolder: (): Promise<void> => ok(undefined),
  saveCostScope: (): Promise<void> => ok(undefined),
  revealCostScopeFolder: (): Promise<void> => ok(undefined),
  openDataFolder: (): Promise<void> => ok(undefined),
  cancelPendingQueries: (): Promise<void> => ok(undefined),
  clearAllCaches: (): Promise<void> => ok(undefined),

  // ---- Stubbed: sync / AWS / data management ----
  syncPeriods: (): Promise<{ filesDownloaded: number; rowsProcessed: number }> => ok({ filesDownloaded: 0, rowsProcessed: 0 }),
  cancelSync: (): Promise<void> => ok(undefined),
  deleteLocalPeriod: (): Promise<void> => ok(undefined),
  ssoLogin: (): Promise<void> => ok(undefined),
  testConnection: (): Promise<{ ok: boolean; error?: string | undefined }> => ok({ ok: false, error: 'Disabled in Tauri spike (fixture mode)' }),
  listAwsProfiles: (): Promise<string[]> => invoke('list_aws_profiles'),
  listS3Buckets: (): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> => ok({ buckets: [] }),
  browseS3: (): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> =>
    ok({ prefixes: [], isCurReport: false, detectedType: 'unknown', missingColumns: [] }),
  scaffoldConfig: (): Promise<void> => ok(undefined),
  writeConfig: (): Promise<void> => ok(undefined),
  updateAwsProfile: (): Promise<void> => ok(undefined),

  // ---- Stubbed: auto-sync ----
  getAutoSyncEnabled: (): Promise<boolean> => ok(false),
  setAutoSyncEnabled: (): Promise<void> => ok(undefined),
  getAutoSyncIntervalMinutes: (): Promise<number> => ok(60),
  setAutoSyncIntervalMinutes: (): Promise<void> => ok(undefined),
  getAutoSyncStatus: (): Promise<AutoSyncStatus> => ok({ state: 'disabled' }),

  // ---- Stubbed: AWS Organizations / SSM ----
  syncOrgAccounts: (profile: string): Promise<OrgSyncResult> => invoke('sync_org_accounts', { profile }),
  getOrgSyncResult: (): Promise<OrgSyncResult | null> => invoke('get_org_sync_result'),
  getOrgSyncProgress: (): Promise<OrgSyncProgress | null> => ok(null),
  getRegionNamesInfo: (): Promise<{ count: number; syncedAt: string; lastError: string | null; regions: Record<string, { longName: string; country: string; continent: string }> } | null> => ok(null),
  clearOrgData: (): Promise<void> => ok(undefined),
  syncRegionNames: (): Promise<{ count: number; syncedAt: string }> => ok({ count: 0, syncedAt: new Date(0).toISOString() }),

  // ---- Stubbed: alias suggestions ----
  getAliasSuggestions: (): Promise<AliasSuggestion[]> => ok([]),
  dismissSuggestion: (): Promise<void> => ok(undefined),
  acceptSuggestion: (): Promise<void> => ok(undefined),

  // ---- Stubbed: config sharing ----
  exportConfigBundle: (): Promise<ExportConfigBundleResult> => ok({ status: 'error', message: 'Disabled in Tauri spike' }),
  previewConfigBundleFile: (): Promise<PreviewConfigBundleResult> => ok({ status: 'error', message: 'Disabled in Tauri spike' }),
  fetchConfigBundleFromS3: (): Promise<PreviewConfigBundleResult> => ok({ status: 'error', message: 'Disabled in Tauri spike' }),
  applyConfigBundle: (_params: ApplyConfigBundleParams): Promise<ApplyConfigBundleResult> => ok({ status: 'error', message: 'Disabled in Tauri spike' }),
  publishConfigBundle: (): Promise<PublishConfigBundleResult> => ok({ status: 'error', message: 'Disabled in Tauri spike' }),
  checkConfigBeacon: (_params: CheckConfigBeaconParams): Promise<CheckConfigBeaconResult> => ok({ status: 'none' }),

  // ---- Stubbed: MCP server ----
  getMcpServerRunning: (): Promise<boolean> => ok(false),
  setMcpServerRunning: (): Promise<void> => ok(undefined),
  getMcpToken: (): Promise<string> => ok(''),
  regenerateMcpToken: (): Promise<string> => ok(''),
};

// ---------------------------------------------------------------------------
// costgoblinUpdate — no auto-updater in the spike. onStatusChanged returns an
// unsubscribe fn (the renderer relies on that contract).
// ---------------------------------------------------------------------------
const updateApi = {
  checkForUpdates: (): Promise<void> => ok(undefined),
  downloadUpdate: (): Promise<void> => ok(undefined),
  quitAndInstall: (): void => undefined,
  onStatusChanged: (_callback: (status: unknown) => void): (() => void) => () => undefined,
  getAppVersion: (): Promise<string> => invoke('get_app_version'),
};

// ---------------------------------------------------------------------------
// costgoblinDebug — note isDev / isE2E / getInFlightCount are SYNCHRONOUS in
// the Electron preload, so they must stay synchronous here (handled in JS,
// not via invoke).
// ---------------------------------------------------------------------------
const debugApi = {
  isDev: (): boolean => import.meta.env.DEV,
  isE2E: (): boolean => false,
  getMemoryMB: (): Promise<number> => ok(0),
  getInFlightCount: (): number => inFlightCount,
  getQueryLog: (): Promise<unknown[]> => invokeRaw('get_query_log'),
  runExplain: (queryId: number): Promise<string> => invokeRaw('run_explain', { queryId }),
  clearLog: (): Promise<void> => invokeRaw<undefined>('clear_query_log').then(() => undefined),
};

export function installBridge(): void {
  const g = globalThis as unknown as {
    costgoblin: unknown;
    costgoblinUpdate: unknown;
    costgoblinDebug: unknown;
  };
  g.costgoblin = api;
  g.costgoblinUpdate = updateApi;
  g.costgoblinDebug = debugApi;
}
