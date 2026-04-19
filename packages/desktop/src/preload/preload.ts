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
  FileActivityEvent,
  OptimizeStatus,
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
  getFilterValues(dimensionId: string, filters: Record<string, string>, dateRange?: { start: string; end: string }): Promise<{ value: string; label: string; count: number }[]> {
    return invoke<{ value: string; label: string; count: number }[]>('query:filter-values', dimensionId, filters, dateRange);
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
  getFileActivity(sinceIso?: string): Promise<FileActivityEvent[]> {
    return invoke<FileActivityEvent[]>('sync:get-file-activity', sinceIso);
  },
  getOptimizeStatus(): Promise<OptimizeStatus> {
    return invoke<OptimizeStatus>('sync:get-optimize-status');
  },
  getOptimizeEnabled(): Promise<boolean> {
    return invoke<boolean>('optimize:get-enabled');
  },
  setOptimizeEnabled(enabled: boolean): Promise<void> {
    return invoke<undefined>('optimize:set-enabled', enabled).then(() => undefined);
  },
  clearSidecars(): Promise<{ removed: number; requeued: number }> {
    return invoke<{ removed: number; requeued: number }>('optimize:clear-sidecars');
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
  getRegionNamesInfo(): Promise<{ count: number; syncedAt: string; lastError: string | null } | null> {
    return invoke<{ count: number; syncedAt: string; lastError: string | null } | null>('org:get-region-names-info');
  },
  discoverTagKeys(): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> {
    return invoke<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }>('dimensions:discover-tags');
  },
  discoverColumnValues(field: string, opts?: { useOrgAccounts?: boolean; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule }): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }> {
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
  getAutoSyncStatus(): Promise<AutoSyncStatus> {
    return invoke<AutoSyncStatus>('auto-sync:get-status');
  },
};

contextBridge.exposeInMainWorld('costgoblin', api);
