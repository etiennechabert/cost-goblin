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
  UpdateStatus,
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
  getSavingsPreferences: (): Promise<SavingsPreferences> => invoke('get_savings_preferences'),
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
  getSyncStatus: (syncId?: string): Promise<SyncStatus> => invoke('get_sync_status', { syncId: syncId ?? 'default' }),
  querySavings: (): Promise<SavingsResult> => invoke('query_savings'),
  getAccountMapping: (): Promise<AccountMappingStatus> => ok({ status: 'missing' }),
  getCostScopeCapabilities: (): Promise<CostScopeCapabilities> => ok({ hasEffectiveCostColumns: false, hasNetColumns: false, hasListPriceColumn: true }),
  previewCostScope: (_config: CostScopeConfig): Promise<CostScopePreviewResult> => ok({
    windowDays: 0, startDate: '', endDate: '', perRule: [],
    combined: { excludedCost: 0, excludedRows: 0 },
    unscopedTotalCost: 0, scopedTotalCost: 0, dailyTotals: [], sampleRows: [],
    sampleTotalRowCount: 0, tagColumns: [],
  }),

  // ---- Preferences persist to JSON; folder reveals use the OS opener ----
  saveUIPreferences: (prefs: UIPreferences): Promise<void> => invoke<undefined>('save_ui_preferences', prefs).then(() => undefined),
  saveSavingsPreferences: (prefs: SavingsPreferences): Promise<void> => invoke<undefined>('save_savings_preferences', prefs).then(() => undefined),
  saveExplorerPreferences: (prefs: ExplorerPreferences): Promise<void> => invoke<undefined>('save_explorer_preferences', prefs).then(() => undefined),
  openDataFolder: (): Promise<void> => invoke<undefined>('open_data_folder').then(() => undefined),
  revealViewsFolder: (): Promise<void> => invoke<undefined>('reveal_config_folder').then(() => undefined),
  revealCostScopeFolder: (): Promise<void> => invoke<undefined>('reveal_config_folder').then(() => undefined),
  // ---- YAML config writes (real: serde_yaml, matching the core *ToYaml shape) ----
  saveDimensionsConfig: (config: DimensionsConfig): Promise<void> => invoke<undefined>('save_dimensions_config', config).then(() => undefined),
  saveViewsConfig: (config: ViewsConfig): Promise<void> => invoke<undefined>('save_views_config', config).then(() => undefined),
  resetViewsConfig: (): Promise<ViewsConfig> => invoke('get_views_config'),
  saveCostScope: (config: CostScopeConfig): Promise<void> => invoke<undefined>('save_cost_scope', config).then(() => undefined),
  cancelPendingQueries: (): Promise<void> => ok(undefined),
  clearAllCaches: (): Promise<void> => ok(undefined),

  // ---- S3 CUR sync (real: `aws s3 sync` CLI + SDK ListObjectsV2 inventory) ----
  syncPeriods: (files: readonly { key: string; contentHash: string; size: number }[], syncId?: string): Promise<{ filesDownloaded: number; rowsProcessed: number }> =>
    invoke('sync_periods', { files, syncId: syncId ?? 'default' }),
  cancelSync: (syncId?: string): Promise<void> => invoke<undefined>('cancel_sync', { syncId: syncId ?? 'default' }).then(() => undefined),
  deleteLocalPeriod: (period: string, tier?: DataTier): Promise<void> => invoke<undefined>('delete_local_period', { period, tier: tier ?? 'daily' }).then(() => undefined),
  ssoLogin: (profile: string): Promise<void> => invoke<undefined>('sso_login', { profile }).then(() => undefined),
  // ---- Stubbed: setup-wizard-only AWS discovery (app is already configured) ----
  testConnection: (): Promise<{ ok: boolean; error?: string | undefined }> => ok({ ok: false, error: 'Disabled in Tauri spike (fixture mode)' }),
  listAwsProfiles: (): Promise<string[]> => invoke('list_aws_profiles'),
  listS3Buckets: (): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> => ok({ buckets: [] }),
  browseS3: (): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> =>
    ok({ prefixes: [], isCurReport: false, detectedType: 'unknown', missingColumns: [] }),
  scaffoldConfig: (): Promise<void> => ok(undefined),
  writeConfig: (): Promise<void> => ok(undefined),
  updateAwsProfile: (profile: string): Promise<void> => invoke<undefined>('update_aws_profile', { profile }).then(() => undefined),

  // ---- Stubbed: auto-sync ----
  getAutoSyncEnabled: (): Promise<boolean> => ok(false),
  setAutoSyncEnabled: (): Promise<void> => ok(undefined),
  getAutoSyncIntervalMinutes: (): Promise<number> => ok(60),
  setAutoSyncIntervalMinutes: (): Promise<void> => ok(undefined),
  getAutoSyncStatus: (): Promise<AutoSyncStatus> => ok({ state: 'disabled' }),

  // ---- AWS Organizations / SSM (real: aws-sdk-organizations + aws-sdk-ssm) ----
  syncOrgAccounts: (profile: string): Promise<OrgSyncResult> => invoke('sync_org_accounts', { profile }),
  getOrgSyncResult: (): Promise<OrgSyncResult | null> => invoke('get_org_sync_result'),
  getOrgSyncProgress: (): Promise<OrgSyncProgress | null> => ok(null),
  getRegionNamesInfo: (): Promise<{ count: number; syncedAt: string; lastError: string | null; regions: Record<string, { longName: string; country: string; continent: string }> } | null> => invoke('get_region_names_info'),
  clearOrgData: (): Promise<void> => invoke<undefined>('clear_org_data').then(() => undefined),
  syncRegionNames: (profile: string): Promise<{ count: number; syncedAt: string }> => invoke('sync_region_names', { profile }),

  // ---- Stubbed: alias suggestions ----
  getAliasSuggestions: (): Promise<AliasSuggestion[]> => ok([]),
  dismissSuggestion: (): Promise<void> => ok(undefined),
  acceptSuggestion: (): Promise<void> => ok(undefined),

  // ---- Config sharing (real: bundle fingerprint + native dialogs + S3) ----
  exportConfigBundle: (): Promise<ExportConfigBundleResult> => invoke('export_config_bundle'),
  previewConfigBundleFile: (): Promise<PreviewConfigBundleResult> => invoke('preview_config_bundle_file'),
  fetchConfigBundleFromS3: (params: { profile: string; location: string }): Promise<PreviewConfigBundleResult> => invoke('fetch_config_bundle_from_s3', params),
  applyConfigBundle: (params: ApplyConfigBundleParams): Promise<ApplyConfigBundleResult> => invoke('apply_config_bundle', params),
  publishConfigBundle: (params?: { location?: string; profile?: string }): Promise<PublishConfigBundleResult> => invoke('publish_config_bundle', params ?? {}),
  checkConfigBeacon: (params: CheckConfigBeaconParams): Promise<CheckConfigBeaconResult> => invoke('check_config_beacon', params),

  // ---- MCP server (real: tiny_http JSON-RPC over the query layer) ----
  getMcpServerRunning: (): Promise<boolean> => invoke('get_mcp_server_running'),
  setMcpServerRunning: (enabled: boolean): Promise<void> => invoke<undefined>('set_mcp_server_running', { enabled }).then(() => undefined),
  getMcpToken: (): Promise<string> => invoke('get_mcp_token'),
  regenerateMcpToken: (): Promise<string> => invoke('regenerate_mcp_token'),
};

// ---------------------------------------------------------------------------
// costgoblinUpdate — the interface is fully ported (state machine + a real
// onStatusChanged subscription), so the ReleaseNotesModal works end-to-end. The
// Rust commands honestly report "idle": actually finding an update needs a
// Tauri-format signed release feed, which doesn't exist yet (the GitHub
// releases are electron-builder format). See specs/rust-tauri-migration.md.
// ---------------------------------------------------------------------------
let updateStatus: UpdateStatus = { state: 'idle' };
const updateListeners = new Set<(status: UpdateStatus) => void>();
function emitUpdate(status: UpdateStatus): void {
  updateStatus = status;
  for (const cb of updateListeners) cb(status);
}
const updateApi = {
  checkForUpdates: async (): Promise<void> => {
    emitUpdate({ state: 'checking' });
    emitUpdate(await invoke<UpdateStatus>('check_for_updates'));
  },
  downloadUpdate: async (): Promise<void> => {
    emitUpdate(await invoke<UpdateStatus>('download_update'));
  },
  quitAndInstall: (): void => { void invokeRaw('quit_and_install'); },
  onStatusChanged: (callback: (status: UpdateStatus) => void): (() => void) => {
    updateListeners.add(callback);
    callback(updateStatus);
    return () => { updateListeners.delete(callback); };
  },
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
