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
} from '@costgoblin/core';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
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
  getConfig(): Promise<CostGoblinConfig> {
    return invoke<CostGoblinConfig>('config:get');
  },
  getDimensions(): Promise<Dimension[]> {
    return invoke<Dimension[]>('config:dimensions');
  },
  getOrgTree(): Promise<OrgNode[]> {
    return invoke<OrgNode[]>('config:org-tree');
  },
  getFilterValues(dimensionId: string, filters: Record<string, string>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }): Promise<{ value: string; label: string; count: number }[]> {
    return invoke<{ value: string; label: string; count: number }[]>('query:filter-values', dimensionId, filters, dateRange, opts);
  },
  getDataInventory(tier?: DataTier): Promise<DataInventoryResult> {
    return invoke<DataInventoryResult>('data:inventory', tier);
  },
  syncPeriods(files: readonly { key: string; contentHash: string; size: number }[], syncId?: string): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
    return invoke<{ filesDownloaded: number; rowsProcessed: number }>('data:sync-periods', files, syncId);
  },
  cancelSync(syncId?: string): Promise<void> {
    return invoke<undefined>('data:cancel-sync', syncId).then(() => undefined);
  },
  deleteLocalPeriod(period: string, tier?: DataTier): Promise<void> {
    return invoke<undefined>('data:delete-period', period, tier).then(() => undefined);
  },
  openDataFolder(): Promise<void> {
    return invoke<undefined>('data:open-folder').then(() => undefined);
  },
  getAccountMapping(): Promise<AccountMappingStatus> {
    return invoke<AccountMappingStatus>('data:account-mapping');
  },
  getSetupStatus(): Promise<{ configured: boolean }> {
    return invoke<{ configured: boolean }>('setup:status');
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
  browseS3(params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> {
    return invoke<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }>('setup:browse-s3', params);
  },
  scaffoldConfig(): Promise<void> {
    return invoke<undefined>('setup:scaffold-config').then(() => undefined);
  },
  writeConfig(config: { providerName: string; profile: string; dailyBucket: string; retentionDays?: number | undefined; hourlyBucket?: string | undefined; costOptBucket?: string | undefined; tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined }): Promise<void> {
    return invoke<undefined>('setup:write-config', config).then(() => undefined);
  },
  updateAwsProfile(profile: string): Promise<void> {
    return invoke<undefined>('config:update-aws-profile', profile).then(() => undefined);
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
  syncOrgAccounts(profile: string): Promise<OrgSyncResult> {
    return invoke<OrgSyncResult>('org:sync-accounts', profile);
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
  getCostScopeCapabilities(): Promise<CostScopeCapabilities> {
    return invoke<CostScopeCapabilities>('cost-scope:get-capabilities');
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
  getExplorerFilterValues(params: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]> {
    return invoke<ExplorerFilterValue[]>('explorer:filter-values', params);
  },
  getExplorerPreferences(): Promise<ExplorerPreferences> {
    return invoke<ExplorerPreferences>('explorer:get-preferences');
  },
  saveExplorerPreferences(prefs: ExplorerPreferences): Promise<void> {
    return invoke<undefined>('explorer:save-preferences', prefs).then(() => undefined);
  },
};

contextBridge.exposeInMainWorld('costgoblin', api);
