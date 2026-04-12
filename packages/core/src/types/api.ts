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
  SavingsResult,
  SyncStatus,
  TrendQueryParams,
  TrendResult,
} from './query.js';

export interface SavingsPreferences {
  readonly hiddenActionTypes: readonly string[];
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
  triggerSync(): Promise<void>;
  getConfig(): Promise<CostGoblinConfig>;
  getDimensions(): Promise<Dimension[]>;
  getOrgTree(): Promise<OrgNode[]>;
  getDataInventory(tier?: DataTier): Promise<DataInventoryResult>;
  syncPeriods(files: readonly { key: string; contentHash: string; size: number }[], syncId?: string): Promise<{ filesDownloaded: number; rowsProcessed: number }>;
  cancelSync(syncId?: string): Promise<void>;
  getFilterValues(dimensionId: string, filters: Record<string, string>, dateRange?: { start: string; end: string }): Promise<{ value: string; label: string; count: number }[]>;
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
  writeConfig(config: {
    providerName: string;
    profile: string;
    dailyBucket: string;
    retentionDays?: number | undefined;
    hourlyBucket?: string | undefined;
    costOptBucket?: string | undefined;
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
