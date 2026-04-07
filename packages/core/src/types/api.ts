import type { BuiltInDimension, CostGoblinConfig, OrgNode, TagDimension } from './config.js';
import type {
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  EntityDetailParams,
  EntityDetailResult,
  MissingTagsParams,
  MissingTagsResult,
  SyncStatus,
  TrendQueryParams,
  TrendResult,
} from './query.js';

export type Dimension = BuiltInDimension | TagDimension;

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
    readonly dailyDates: readonly string[];
    readonly dailyDiskBytes: number;
    readonly hourlyDates: readonly string[];
    readonly hourlyDiskBytes: number;
    readonly oldestDate: string | null;
    readonly newestDate: string | null;
  };
}

export interface CostApi {
  queryCosts(params: CostQueryParams): Promise<CostResult>;
  queryDailyCosts(params: DailyCostsParams): Promise<DailyCostsResult>;
  queryTrends(params: TrendQueryParams): Promise<TrendResult>;
  queryMissingTags(params: MissingTagsParams): Promise<MissingTagsResult>;
  queryEntityDetail(params: EntityDetailParams): Promise<EntityDetailResult>;
  getSyncStatus(): Promise<SyncStatus>;
  triggerSync(): Promise<void>;
  getConfig(): Promise<CostGoblinConfig>;
  getDimensions(): Promise<Dimension[]>;
  getOrgTree(): Promise<OrgNode[]>;
  getDataInventory(): Promise<DataInventoryResult>;
  syncPeriods(files: readonly { key: string; contentHash: string; size: number }[]): Promise<{ filesDownloaded: number; rowsProcessed: number }>;
  getFilterValues(dimensionId: string, filters: Record<string, string>, dateRange?: { start: string; end: string }): Promise<{ value: string; label: string; count: number }[]>;
  deleteLocalPeriod(period: string): Promise<void>;
  openDataFolder(): Promise<void>;
  getAccountMapping(): Promise<AccountMappingStatus>;
  getSetupStatus(): Promise<{ configured: boolean }>;
  testConnection(params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }>;
  writeConfig(config: {
    providerName: string;
    profile: string;
    dailyBucket: string;
    hourlyBucket?: string | undefined;
    tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined;
  }): Promise<void>;
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
