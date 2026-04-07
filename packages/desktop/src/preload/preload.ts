import { contextBridge, ipcRenderer } from 'electron';
import type { CostApi, Dimension } from '@costgoblin/core';
import type {
  CostGoblinConfig,
  OrgNode,
  CostQueryParams,
  CostResult,
  TrendQueryParams,
  TrendResult,
  MissingTagsParams,
  MissingTagsResult,
  EntityDetailParams,
  EntityDetailResult,
  SyncStatus,
  DataInventoryResult,
  AccountMappingStatus,
} from '@costgoblin/core';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: CostApi = {
  queryCosts(params: CostQueryParams): Promise<CostResult> {
    return invoke<CostResult>('query:costs', params);
  },
  queryTrends(params: TrendQueryParams): Promise<TrendResult> {
    return invoke<TrendResult>('query:trends', params);
  },
  queryMissingTags(params: MissingTagsParams): Promise<MissingTagsResult> {
    return invoke<MissingTagsResult>('query:missing-tags', params);
  },
  queryEntityDetail(params: EntityDetailParams): Promise<EntityDetailResult> {
    return invoke<EntityDetailResult>('query:entity-detail', params);
  },
  getSyncStatus(): Promise<SyncStatus> {
    return invoke<SyncStatus>('sync:status');
  },
  triggerSync(): Promise<void> {
    return invoke<undefined>('sync:trigger').then(() => undefined);
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
  getDataInventory(): Promise<DataInventoryResult> {
    return invoke<DataInventoryResult>('data:inventory');
  },
  syncPeriods(files: readonly { key: string; contentHash: string; size: number }[]): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
    return invoke<{ filesDownloaded: number; rowsProcessed: number }>('data:sync-periods', files);
  },
  deleteLocalPeriod(period: string): Promise<void> {
    return invoke<undefined>('data:delete-period', period).then(() => undefined);
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
  writeConfig(config: { providerName: string; profile: string; dailyBucket: string; hourlyBucket?: string | undefined; tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined }): Promise<void> {
    return invoke<undefined>('setup:write-config', config).then(() => undefined);
  },
};

contextBridge.exposeInMainWorld('costgoblin', api);
