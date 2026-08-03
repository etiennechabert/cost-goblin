// Installs the Sentry IPC bridge the renderer SDK uses to forward events to the
// main process. REQUIRED with sandbox: true + contextIsolation (the renderer has
// no Node/DSN of its own). Must run unconditionally and before any renderer init;
// it's inert until the renderer SDK is actually initialised (i.e. after opt-in).
import '@sentry/electron/preload';
import { contextBridge, ipcRenderer } from 'electron';
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
  SyncLogLine,
  SavingsResult,
  DataInventoryResult,
  DataTier,
  AccountMappingStatus,
  SavingsPreferences,
  UIPreferences,
  PerformanceInfo,
  PerformanceSettings,
  DimensionsConfig,
  NormalizationRule,
  OrgSyncResult,
  OrgSyncProgress,
  AutoSyncStatus,
  PruneResult,
  ViewsConfig,
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
  RollupGrainEstimate,
  TelemetryPreferences,
  TelemetryStatus,
  TelemetryOutboxEntry,
} from '@costgoblin/core';

// ---------------------------------------------------------------------------
// Debug query log entry — mirrors QueryLogEntry from main/query-log.ts
// ---------------------------------------------------------------------------
interface DebugQueryLogEntry {
  readonly id: number;
  readonly sql: string;
  readonly paramCount: number;
  readonly status: 'queued' | 'running' | 'success' | 'error';
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly rowCount: number | null;
  readonly error: string | null;
  readonly materialized: boolean;
  readonly cached: boolean;
  readonly origin: string | null;
}

// ---------------------------------------------------------------------------
// Performance instrumentation — active only when COSTGOBLIN_PERF_MODE=1
// ---------------------------------------------------------------------------
const perfMode = process.env['COSTGOBLIN_PERF_MODE'] === '1';

interface IpcTiming {
  readonly channel: string;
  readonly durationMs: number;
  readonly timestamp: string;
}

const ipcTimings: IpcTiming[] = [];
let inFlightCount = 0;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const start = perfMode ? performance.now() : 0;
  const isDebug = channel.startsWith('debug:');
  if (!isDebug) inFlightCount++;
  const result = ipcRenderer.invoke(channel, ...args) as Promise<T>;
  return result.finally(() => {
    if (!isDebug) inFlightCount--;
    if (perfMode) {
      ipcTimings.push({
        channel,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        timestamp: new Date().toISOString(),
      });
    }
  });
}

const api: CostApi = {
  queryCosts(params: CostQueryParams): Promise<CostResult> {
    return invoke<CostResult>('query:costs', params);
  },
  queryDailyCosts(params: DailyCostsParams): Promise<DailyCostsResult> {
    return invoke<DailyCostsResult>('query:daily-costs', params);
  },
  queryTrends(params: TrendQueryParams): Promise<TrendResult> {
    return invoke<TrendResult>('query:trends', params);
  },
  queryMissingTags(params: MissingTagsParams): Promise<MissingTagsResult> {
    return invoke<MissingTagsResult>('query:missing-tags', params);
  },
  querySavings(): Promise<SavingsResult> {
    return invoke<SavingsResult>('query:savings');
  },
  queryEntityDetail(params: EntityDetailParams): Promise<EntityDetailResult> {
    return invoke<EntityDetailResult>('query:entity-detail', params);
  },
  getSyncStatus(syncId?: string): Promise<SyncStatus> {
    return invoke<SyncStatus>('sync:status', syncId);
  },
  getSyncLog(): Promise<readonly SyncLogLine[]> {
    return invoke<readonly SyncLogLine[]>('sync-log:get');
  },
  subscribeSyncLog(listener: (line: SyncLogLine) => void): () => void {
    const handler = (_event: unknown, line: SyncLogLine): void => { listener(line); };
    ipcRenderer.on('sync-log:append', handler);
    return () => { ipcRenderer.removeListener('sync-log:append', handler); };
  },
  appendSyncLog(level: SyncLogLine['level'], message: string): Promise<void> {
    return invoke<undefined>('sync-log:record', level, message).then(() => undefined);
  },
  clearSyncLog(): Promise<void> {
    return invoke<undefined>('sync-log:clear').then(() => undefined);
  },
  getConfig(): Promise<CostGoblinConfig> {
    return invoke<CostGoblinConfig>('config:get');
  },
  getDimensions(): Promise<Dimension[]> {
    return invoke<Dimension[]>('config:dimensions');
  },
  getOrgTree(): Promise<OrgNode[]> {
    return invoke<OrgNode[]>('config:org-tree');
  },
  getFilterValues(dimensionId: string, filters: Record<string, readonly string[]>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }, origin?: string): Promise<{ value: string; label: string; count: number }[]> {
    return invoke<{ value: string; label: string; count: number }[]>('query:filter-values', dimensionId, filters, dateRange, opts, origin);
  },
  getDataInventory(tier?: DataTier, providerName?: string): Promise<DataInventoryResult> {
    return invoke<DataInventoryResult>('data:inventory', tier, providerName);
  },
  syncPeriods(files: readonly { key: string; contentHash: string; size: number }[], syncId?: string): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
    return invoke<{ filesDownloaded: number; rowsProcessed: number }>('data:sync-periods', files, syncId);
  },
  cancelSync(syncId?: string): Promise<void> {
    return invoke<undefined>('data:cancel-sync', syncId).then(() => undefined);
  },
  deleteLocalPeriod(period: string, tier?: DataTier, providerName?: string): Promise<void> {
    return invoke<undefined>('data:delete-period', period, tier, providerName).then(() => undefined);
  },
  openDataFolder(): Promise<void> {
    return invoke<undefined>('data:open-folder').then(() => undefined);
  },
  ssoLogin(profile: string): Promise<void> {
    return invoke<undefined>('data:sso-login', profile).then(() => undefined);
  },
  getAccountMapping(): Promise<AccountMappingStatus> {
    return invoke<AccountMappingStatus>('data:account-mapping');
  },
  getSetupStatus(): Promise<{ configured: boolean; postSetup: boolean }> {
    return invoke<{ configured: boolean; postSetup: boolean }>('setup:status');
  },
  testConnection(params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }> {
    return invoke<{ ok: boolean; error?: string | undefined }>('setup:test-connection', params);
  },
  listAwsProfiles(): Promise<string[]> {
    return invoke<string[]>('setup:list-profiles');
  },
  listS3Buckets(profile: string): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> {
    return invoke<{ buckets: { name: string; region: string }[]; error?: string | undefined }>('setup:list-buckets', profile);
  },
  browseS3(params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isBillingExport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> {
    return invoke<{ prefixes: string[]; isBillingExport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }>('setup:browse-s3', params);
  },
  scaffoldConfig(): Promise<void> {
    return invoke<undefined>('setup:scaffold-config').then(() => undefined);
  },
  writeConfig(config: { providerName: string; profile: string; dailyBucket: string; retentionDays?: number | undefined; hourlyBucket?: string | undefined; costOptBucket?: string | undefined; tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined }): Promise<void> {
    return invoke<undefined>('setup:write-config', config).then(() => undefined);
  },
  updateAwsProfile(profile: string, providerName?: string): Promise<void> {
    return invoke<undefined>('config:update-aws-profile', profile, providerName).then(() => undefined);
  },
  removeProvider(providerName: string): Promise<void> {
    return invoke<undefined>('config:remove-provider', providerName).then(() => undefined);
  },
  getSavingsPreferences(): Promise<SavingsPreferences> {
    return invoke<SavingsPreferences>('savings:get-preferences');
  },
  saveSavingsPreferences(prefs: SavingsPreferences): Promise<void> {
    return invoke<undefined>('savings:save-preferences', prefs).then(() => undefined);
  },
  getUIPreferences(): Promise<UIPreferences> {
    return invoke<UIPreferences>('ui:get-preferences');
  },
  saveUIPreferences(prefs: UIPreferences): Promise<void> {
    return invoke<undefined>('ui:save-preferences', prefs).then(() => undefined);
  },
  syncOrgAccounts(profile: string, providerName?: string): Promise<OrgSyncResult> {
    return invoke<OrgSyncResult>('org:sync-accounts', profile, providerName);
  },
  getOrgSyncResult(): Promise<OrgSyncResult | null> {
    return invoke<OrgSyncResult | null>('org:get-result');
  },
  getOrgSyncProgress(): Promise<OrgSyncProgress | null> {
    return invoke<OrgSyncProgress | null>('org:get-progress');
  },
  getRegionNamesInfo(): Promise<{ count: number; syncedAt: string; lastError: string | null; regions: Record<string, { longName: string; country: string; continent: string }> } | null> {
    return invoke<{ count: number; syncedAt: string; lastError: string | null; regions: Record<string, { longName: string; country: string; continent: string }> } | null>('org:get-region-names-info');
  },
  clearOrgData(): Promise<void> {
    return invoke<undefined>('org:clear-data').then(() => undefined);
  },
  syncRegionNames(profile: string): Promise<{ count: number; syncedAt: string }> {
    return invoke<{ count: number; syncedAt: string }>('ssm:sync-region-names', profile);
  },
  discoverTagKeys(): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> {
    return invoke<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }>('dimensions:discover-tags');
  },
  discoverColumnValues(field: string, opts?: { useOrgAccounts?: boolean; accountNameFromTag?: string; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule; useRegionNames?: boolean; dimName?: string }): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }> {
    return invoke<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }>('dimensions:discover-column-values', field, opts);
  },
  getDimensionsConfig(): Promise<DimensionsConfig> {
    return invoke<DimensionsConfig>('dimensions:get-config');
  },
  saveDimensionsConfig(config: DimensionsConfig): Promise<void> {
    return invoke<undefined>('dimensions:save-config', config).then(() => undefined);
  },
  estimateRollupGrain(candidate: DimensionsConfig): Promise<RollupGrainEstimate> {
    return invoke<RollupGrainEstimate>('dimensions:estimate-rollup-grain', candidate);
  },
  getAutoSyncEnabled(): Promise<boolean> {
    return invoke<boolean>('auto-sync:get-enabled');
  },
  setAutoSyncEnabled(enabled: boolean): Promise<void> {
    return invoke<undefined>('auto-sync:set-enabled', enabled).then(() => undefined);
  },
  getAutoSyncIntervalMinutes(): Promise<number> {
    return invoke<number>('auto-sync:get-interval');
  },
  setAutoSyncIntervalMinutes(minutes: number): Promise<void> {
    return invoke<undefined>('auto-sync:set-interval', minutes).then(() => undefined);
  },
  getAutoSyncStatus(): Promise<AutoSyncStatus> {
    return invoke<AutoSyncStatus>('auto-sync:get-status');
  },
  getAutoPruneEnabled(): Promise<boolean> {
    return invoke<boolean>('auto-prune:get-enabled');
  },
  setAutoPruneEnabled(enabled: boolean): Promise<void> {
    return invoke<undefined>('auto-prune:set-enabled', enabled).then(() => undefined);
  },
  pruneNow(): Promise<PruneResult> {
    return invoke<PruneResult>('data:prune');
  },
  getViewsConfig(): Promise<ViewsConfig> {
    return invoke<ViewsConfig>('views:get-config');
  },
  saveViewsConfig(config: ViewsConfig): Promise<void> {
    return invoke<undefined>('views:save-config', config).then(() => undefined);
  },
  resetViewsConfig(): Promise<ViewsConfig> {
    return invoke<ViewsConfig>('views:reset-defaults');
  },
  revealViewsFolder(): Promise<void> {
    return invoke<undefined>('views:reveal-folder').then(() => undefined);
  },
  getCostScope(): Promise<CostScopeConfig> {
    return invoke<CostScopeConfig>('cost-scope:get-config');
  },
  saveCostScope(config: CostScopeConfig): Promise<void> {
    return invoke<undefined>('cost-scope:save-config', config).then(() => undefined);
  },
  previewCostScope(config: CostScopeConfig): Promise<CostScopePreviewResult> {
    return invoke<CostScopePreviewResult>('cost-scope:preview', config);
  },
  revealCostScopeFolder(): Promise<void> {
    return invoke<undefined>('cost-scope:reveal-folder').then(() => undefined);
  },
  queryExplorerOverview(params: ExplorerOverviewParams): Promise<ExplorerOverviewResult> {
    return invoke<ExplorerOverviewResult>('explorer:query-overview', params);
  },
  queryExplorerRows(params: ExplorerRowsParams): Promise<ExplorerRowsResult> {
    return invoke<ExplorerRowsResult>('explorer:query-rows', params);
  },
  queryAggregatedTable(params: AggregatedTableParams): Promise<AggregatedTableResult> {
    return invoke<AggregatedTableResult>('explorer:query-aggregated-table', params);
  },
  getExplorerFilterValues(params: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]> {
    return invoke<ExplorerFilterValue[]>('explorer:filter-values', params);
  },
  getExplorerPreferences(): Promise<ExplorerPreferences> {
    return invoke<ExplorerPreferences>('explorer:get-preferences');
  },
  saveExplorerPreferences(prefs: ExplorerPreferences): Promise<void> {
    return invoke<undefined>('explorer:save-preferences', prefs).then(() => undefined);
  },
  getAliasSuggestions(tagName: string): Promise<AliasSuggestion[]> {
    return invoke<AliasSuggestion[]>('dimensions:get-alias-suggestions', tagName);
  },
  dismissSuggestion(tagName: string, canonical: string, aliases: readonly string[]): Promise<void> {
    return invoke<undefined>('dimensions:dismiss-suggestion', tagName, canonical, aliases).then(() => undefined);
  },
  acceptSuggestion(tagName: string, canonical: string, aliases: readonly string[]): Promise<void> {
    return invoke<undefined>('dimensions:accept-suggestion', tagName, canonical, aliases).then(() => undefined);
  },
  exportConfigBundle(): Promise<ExportConfigBundleResult> {
    return invoke<ExportConfigBundleResult>('sharing:export-bundle');
  },
  previewConfigBundleFile(): Promise<PreviewConfigBundleResult> {
    return invoke<PreviewConfigBundleResult>('sharing:preview-bundle-file');
  },
  fetchConfigBundleFromS3(params: { profile: string; location: string }): Promise<PreviewConfigBundleResult> {
    return invoke<PreviewConfigBundleResult>('sharing:fetch-bundle-from-s3', params);
  },
  applyConfigBundle(params: ApplyConfigBundleParams): Promise<ApplyConfigBundleResult> {
    return invoke<ApplyConfigBundleResult>('sharing:apply-bundle', params);
  },
  publishConfigBundle(params?: { location?: string | undefined; profile?: string | undefined }): Promise<PublishConfigBundleResult> {
    return invoke<PublishConfigBundleResult>('sharing:publish-bundle', params);
  },
  checkConfigBeacon(params: CheckConfigBeaconParams): Promise<CheckConfigBeaconResult> {
    return invoke<CheckConfigBeaconResult>('sharing:check-beacon', params);
  },
  getDataSharingStatus(): Promise<DataSharingStatus> {
    return invoke<DataSharingStatus>('data-sharing:status');
  },
  enableDataSharing(): Promise<DataSharingResult> {
    return invoke<DataSharingResult>('data-sharing:enable');
  },
  disableDataSharing(): Promise<DataSharingResult> {
    return invoke<DataSharingResult>('data-sharing:disable');
  },
  rotateDataSharingKey(): Promise<DataSharingResult> {
    return invoke<DataSharingResult>('data-sharing:rotate');
  },
  previewSharedSource(key: string): Promise<PreviewSharedSourceResult> {
    return invoke<PreviewSharedSourceResult>('data-sharing:preview-source', key);
  },
  previewStoredSource(): Promise<PreviewSharedSourceResult> {
    return invoke<PreviewSharedSourceResult>('data-sharing:preview-stored-source');
  },
  addSharedSource(key: string, selection?: SharedPullSelection): Promise<PullSharedSourceResult> {
    return invoke<PullSharedSourceResult>('data-sharing:add-source', key, selection);
  },
  getSharedSource(): Promise<SharedSourceInfo | null> {
    return invoke<SharedSourceInfo | null>('data-sharing:get-source');
  },
  getSharedPullProgress(): Promise<SharedPullProgress> {
    return invoke<SharedPullProgress>('data-sharing:pull-progress');
  },
  refreshSharedSource(selection?: SharedPullSelection): Promise<PullSharedSourceResult> {
    return invoke<PullSharedSourceResult>('data-sharing:refresh-source', selection);
  },
  removeSharedSource(): Promise<void> {
    return invoke<undefined>('data-sharing:remove-source').then(() => undefined);
  },
  cancelPendingQueries(): Promise<void> {
    void invoke<undefined>('debug:clear-completed');
    // Use ipcRenderer directly — cancel calls shouldn't inflate the in-flight badge
    return (ipcRenderer.invoke('query:cancel-pending') as Promise<undefined>).then(() => undefined);
  },
  clearAllCaches(): Promise<void> {
    return invoke<undefined>('cache:clear-all').then(() => undefined);
  },
  getPerformanceInfo(): Promise<PerformanceInfo> {
    return invoke<PerformanceInfo>('perf:get-info');
  },
  setPerformanceSettings(perf: PerformanceSettings): Promise<void> {
    return invoke<undefined>('perf:set', perf).then(() => undefined);
  },
  awaitMaterializedBase(timeoutMs: number): Promise<boolean> {
    return invoke<boolean>('costs:await-base', timeoutMs);
  },
  getMcpServerRunning(): Promise<boolean> {
    return invoke<boolean>('mcp:get-running');
  },
  setMcpServerRunning(enabled: boolean): Promise<void> {
    return invoke<undefined>('mcp:set-running', enabled).then(() => undefined);
  },
  getMcpToken(): Promise<string> {
    return invoke<string>('mcp:get-token');
  },
  regenerateMcpToken(): Promise<string> {
    return invoke<string>('mcp:regenerate-token');
  },
  listBaselines(params) {
    return invoke('baselines:list', params);
  },
  getBaseline(id) {
    return invoke('baselines:get', id);
  },
  createBaseline(input) {
    return invoke('baselines:create', input);
  },
  updateBaseline(id, patch) {
    return invoke('baselines:update', id, patch);
  },
  deleteBaseline(id) {
    return invoke<undefined>('baselines:delete', id).then(() => undefined);
  },
  recomputeBaselines(opts) {
    return invoke<undefined>('baselines:recompute', opts).then(() => undefined);
  },
  getBaselineSnapshots(id) {
    return invoke('baselines:snapshots', id);
  },
  getBaselineDrift(id, childDimension) {
    return invoke('baselines:drift', id, childDimension);
  },
  getBaselinesConfig() {
    return invoke('baselines:get-config');
  },
  setBaselinesConfig(config) {
    return invoke('baselines:set-config', config);
  },
  resetBaselinesConfig() {
    return invoke('baselines:reset-config');
  },
  getTelemetryPreferences(): Promise<TelemetryPreferences> {
    return invoke<TelemetryPreferences>('telemetry:get-preferences');
  },
  setTelemetryPreferences(prefs: TelemetryPreferences): Promise<void> {
    return invoke<undefined>('telemetry:set-preferences', prefs).then(() => undefined);
  },
  getTelemetryStatus(): Promise<TelemetryStatus> {
    return invoke<TelemetryStatus>('telemetry:get-status');
  },
  getTelemetryOutbox(): Promise<readonly TelemetryOutboxEntry[]> {
    return invoke<readonly TelemetryOutboxEntry[]>('telemetry:get-outbox');
  },
  getWorkspaces() {
    return invoke('workspaces:list');
  },
  createWorkspace(name, source, switchTo) {
    return invoke('workspaces:create', name, source, switchTo);
  },
  renameWorkspace(from, to) {
    return invoke('workspaces:rename', from, to);
  },
  deleteWorkspace(name) {
    return invoke('workspaces:delete', name);
  },
  switchWorkspace(name) {
    return invoke<undefined>('workspaces:switch', name).then(() => undefined);
  },
  completeSetup(workspaceName) {
    return invoke<undefined>('workspaces:complete-setup', workspaceName).then(() => undefined);
  },
};

contextBridge.exposeInMainWorld('costgoblin', api);

contextBridge.exposeInMainWorld('costgoblinBaselines', {
  getStatus(): Promise<unknown> {
    return invoke<unknown>('baselines:status');
  },
  onStatusChanged(callback: (status: unknown) => void): () => void {
    const handler = (_event: unknown, status: unknown): void => { callback(status); };
    ipcRenderer.on('baselines:status-changed', handler);
    return () => { ipcRenderer.removeListener('baselines:status-changed', handler); };
  },
});

contextBridge.exposeInMainWorld('costgoblinUpdate', {
  checkForUpdates(): Promise<void> {
    return invoke<undefined>('update:check').then(() => undefined);
  },
  downloadUpdate(): Promise<void> {
    return invoke<undefined>('update:download').then(() => undefined);
  },
  quitAndInstall(): void {
    ipcRenderer.invoke('update:quit-and-install').catch(() => undefined);
  },
  relaunch(postSetup?: boolean): void {
    ipcRenderer.invoke('app:relaunch', postSetup === true).catch(() => undefined);
  },
  onStatusChanged(callback: (status: unknown) => void): () => void {
    const handler = (_event: unknown, status: unknown): void => { callback(status); };
    ipcRenderer.on('update:status-changed', handler);
    return () => { ipcRenderer.removeListener('update:status-changed', handler); };
  },
  getAppVersion(): Promise<string> {
    return invoke<string>('update:get-app-version');
  },
});

contextBridge.exposeInMainWorld('costgoblinRollup', {
  getStatus(): Promise<unknown> {
    return invoke<unknown>('rollup:get-status');
  },
  getStats(): Promise<unknown> {
    return invoke<unknown>('rollup:get-stats');
  },
  onStatusChanged(callback: (status: unknown) => void): () => void {
    const handler = (_event: unknown, status: unknown): void => { callback(status); };
    ipcRenderer.on('rollup:status-changed', handler);
    return () => { ipcRenderer.removeListener('rollup:status-changed', handler); };
  },
});

contextBridge.exposeInMainWorld('costgoblinDebug', {
  isDev(): boolean { return process.env['NODE_ENV'] === 'development'; },
  isE2E(): boolean { return process.env['COSTGOBLIN_E2E'] === '1'; },
  getMemoryMB(): Promise<number> { return invoke<number>('debug:get-memory-mb'); },
  getGitBranch(): Promise<string | null> { return invoke<string | null>('debug:get-git-branch'); },
  getBranchPr(): Promise<BranchPrInfo | null> { return invoke<BranchPrInfo | null>('debug:get-branch-pr'); },
  isSandboxed(): boolean { return process.sandboxed; },
  getInFlightCount(): number { return inFlightCount; },
  getQueryLog(): Promise<DebugQueryLogEntry[]> {
    return invoke<DebugQueryLogEntry[]>('debug:get-query-log');
  },
  runExplain(queryId: number): Promise<string> {
    return invoke<string>('debug:run-explain', queryId);
  },
  clearLog(): Promise<void> {
    return invoke<undefined>('debug:clear-query-log').then(() => undefined);
  },
});

if (perfMode) {
  contextBridge.exposeInMainWorld('costgoblinPerf', {
    getIpcTimings(): IpcTiming[] { return [...ipcTimings]; },
    clearIpcTimings(): void { ipcTimings.length = 0; },
    startCpuProfile(): Promise<undefined> { return invoke<undefined>('perf:start-cpu-profile'); },
    stopCpuProfile(label: string): Promise<{ path: string }> {
      return invoke<{ path: string }>('perf:stop-cpu-profile', label);
    },
  });
}
