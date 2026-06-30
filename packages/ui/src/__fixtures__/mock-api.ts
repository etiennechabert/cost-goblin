import {
  asBucketPath,
  asDimensionId,
  asDollars,
  asDateString,
  asEntityRef,
  type AccountMappingStatus,
  type CostApi,
  type PerformanceInfo,
  type CostResult,
  type DailyCostsResult,
  type DataInventoryResult,
  type Dimension,
  type EntityDetailResult,
  type MissingTagsResult,
  type OrgNode,
  type PruneResult,
  type SavingsResult,
  type SyncStatus,
  type SyncLogLine,
  type TrendResult,
  type CostGoblinConfig,
  type DimensionsConfig,
  type ViewsConfig,
  type CostScopeCapabilities,
  type CostScopeConfig,
  type CostScopePreviewResult,
  type ExplorerFilterValue,
  type ExplorerOverviewResult,
  type ExplorerRowsResult,
  type AliasSuggestion,
  type ApplyConfigBundleResult,
  type CheckConfigBeaconParams,
  type CheckConfigBeaconResult,
  type ConfigBundleSummary,
  type DataSharingResult,
  type DataSharingStatus,
  type ExportConfigBundleResult,
  type PreviewConfigBundleResult,
  type PreviewSharedSourceResult,
  type PublishConfigBundleResult,
  type PullSharedSourceResult,
  type SharedPullProgress,
  type SharedPullSelection,
  type SharedSourcePreview,
  type SharedSourceInfo,
  type BaselinesListResult,
  type BaselineDetail,
  type BaselineRecord,
  type BaselineCreateInput,
  type BaselineSnapshot,
  type BaselineDriftRow,
  type BaselinesConfigState,
  type BaselinesDiscoveryConfig,
  type RollupGrainEstimate,
  type TelemetryPreferences,
  type TelemetryStatus,
  type TelemetryOutboxEntry,
} from '@costgoblin/core/browser';
import { DEFAULT_COST_SCOPE, computeRollupEstimate } from '@costgoblin/core/browser';

const MOCK_PEER_HOST = 'mock-peer.local';

const costResult: CostResult = {
  rows: [
    {
      entity: asEntityRef('platform'),
      totalCost: asDollars(42_300.5),
      serviceCosts: {
        'Amazon EC2': asDollars(18_000),
        'Amazon RDS': asDollars(9_500),
        'Amazon S3': asDollars(6_200),
        'AWS Lambda': asDollars(4_100),
        'Amazon CloudFront': asDollars(4_500.5),
      },
    },
    {
      entity: asEntityRef('data'),
      totalCost: asDollars(31_750),
      serviceCosts: {
        'Amazon EC2': asDollars(10_000),
        'Amazon RDS': asDollars(14_000),
        'Amazon S3': asDollars(5_200),
        'AWS Lambda': asDollars(1_500),
        'Amazon CloudFront': asDollars(1_050),
      },
    },
    {
      entity: asEntityRef('growth'),
      totalCost: asDollars(18_900),
      serviceCosts: {
        'Amazon EC2': asDollars(7_000),
        'Amazon RDS': asDollars(4_500),
        'Amazon S3': asDollars(3_100),
        'AWS Lambda': asDollars(2_800),
        'Amazon CloudFront': asDollars(1_500),
      },
    },
    {
      entity: asEntityRef('infra'),
      totalCost: asDollars(14_200),
      serviceCosts: {
        'Amazon EC2': asDollars(9_000),
        'Amazon RDS': asDollars(2_000),
        'Amazon S3': asDollars(1_800),
        'AWS Lambda': asDollars(900),
        'Amazon CloudFront': asDollars(500),
      },
    },
    {
      entity: asEntityRef('ml'),
      totalCost: asDollars(9_600),
      serviceCosts: {
        'Amazon EC2': asDollars(5_500),
        'Amazon RDS': asDollars(1_200),
        'Amazon S3': asDollars(1_400),
        'AWS Lambda': asDollars(800),
        'Amazon CloudFront': asDollars(700),
      },
    },
  ],
  totalCost: asDollars(116_750.5),
  topServices: ['Amazon EC2', 'Amazon RDS', 'Amazon S3', 'AWS Lambda', 'Amazon CloudFront'],
  dateRange: { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') },
};

const trendResult: TrendResult = {
  increases: [
    { entity: asEntityRef('ml'), currentCost: asDollars(9_600), previousCost: asDollars(7_200), delta: asDollars(2_400), percentChange: 33.3 },
    { entity: asEntityRef('platform'), currentCost: asDollars(42_300.5), previousCost: asDollars(38_100), delta: asDollars(4_200.5), percentChange: 11 },
    { entity: asEntityRef('growth'), currentCost: asDollars(18_900), previousCost: asDollars(17_500), delta: asDollars(1_400), percentChange: 8 },
  ],
  savings: [
    { entity: asEntityRef('infra'), currentCost: asDollars(14_200), previousCost: asDollars(16_800), delta: asDollars(-2_600), percentChange: -15.5 },
    { entity: asEntityRef('data'), currentCost: asDollars(31_750), previousCost: asDollars(33_400), delta: asDollars(-1_650), percentChange: -4.9 },
  ],
  totalIncrease: asDollars(8_000.5),
  totalSavings: asDollars(4_250),
};

const missingTagsResult: MissingTagsResult = {
  rows: [
    { accountId: '123456789012', accountName: 'prod-main', resourceId: 'i-0abc123def456gh78', service: 'Amazon EC2', serviceFamily: 'Compute', cost: asDollars(1_200), closestOwner: asEntityRef('platform'), bucket: 'actionable', categoryTaggedRatio: 0.82 },
    { accountId: '234567890123', accountName: 'prod-data', resourceId: 'arn:aws:rds:us-east-1:234567890123:db:analytics-prod', service: 'Amazon RDS', serviceFamily: 'Database', cost: asDollars(870), closestOwner: asEntityRef('data'), bucket: 'actionable', categoryTaggedRatio: 0.65 },
    { accountId: '345678901234', accountName: 'staging', resourceId: 'arn:aws:s3:::untagged-bucket-staging', service: 'Amazon S3', serviceFamily: 'Storage', cost: asDollars(340), closestOwner: null, bucket: 'likely-untaggable', categoryTaggedRatio: 0 },
  ],
  totalRows: 3,
  totalActionableCost: asDollars(2_070),
  totalLikelyUntaggableCost: asDollars(340),
  totalNonResourceCost: asDollars(150),
  actionableCount: 2,
  likelyUntaggableCount: 1,
  unfilteredActionableCount: 2,
  unfilteredActionableCost: asDollars(2_070),
  unfilteredLikelyUntaggableCount: 1,
  unfilteredLikelyUntaggableCost: asDollars(340),
  nonResourceRows: [
    { service: 'Tax', serviceFamily: '', lineItemType: 'Tax', cost: asDollars(95) },
    { service: 'AWS Support', serviceFamily: '', lineItemType: 'Fee', cost: asDollars(55) },
  ],
};

const entityDetailResult: EntityDetailResult = {
  entity: asEntityRef('platform'),
  totalCost: asDollars(42_300.5),
  previousCost: asDollars(38_100),
  percentChange: 11,
  dailyCosts: [
    { date: asDateString('2026-03-29'), cost: asDollars(1_380), breakdown: { 'Amazon EC2': asDollars(580), 'Amazon RDS': asDollars(310), 'Amazon S3': asDollars(200), 'AWS Lambda': asDollars(140), 'Amazon CloudFront': asDollars(150) }, breakdownByAccount: { 'prod-main': asDollars(900), 'prod-secondary': asDollars(330), 'staging': asDollars(150) } },
    { date: asDateString('2026-03-30'), cost: asDollars(1_420), breakdown: { 'Amazon EC2': asDollars(600), 'Amazon RDS': asDollars(320), 'Amazon S3': asDollars(205), 'AWS Lambda': asDollars(145), 'Amazon CloudFront': asDollars(150) }, breakdownByAccount: { 'prod-main': asDollars(930), 'prod-secondary': asDollars(340), 'staging': asDollars(150) } },
    { date: asDateString('2026-03-31'), cost: asDollars(1_360), breakdown: { 'Amazon EC2': asDollars(560), 'Amazon RDS': asDollars(305), 'Amazon S3': asDollars(198), 'AWS Lambda': asDollars(147), 'Amazon CloudFront': asDollars(150) }, breakdownByAccount: { 'prod-main': asDollars(880), 'prod-secondary': asDollars(330), 'staging': asDollars(150) } },
  ],
  byAccount: [
    { name: 'prod-main', cost: asDollars(28_000), percentage: 66.2 },
    { name: 'prod-secondary', cost: asDollars(10_000), percentage: 23.6 },
    { name: 'staging', cost: asDollars(4_300.5), percentage: 10.2 },
  ],
  byService: [
    { name: 'Amazon EC2', cost: asDollars(18_000), percentage: 42.6 },
    { name: 'Amazon RDS', cost: asDollars(9_500), percentage: 22.5 },
    { name: 'Amazon S3', cost: asDollars(6_200), percentage: 14.7 },
    { name: 'Amazon CloudFront', cost: asDollars(4_500.5), percentage: 10.6 },
    { name: 'AWS Lambda', cost: asDollars(4_100), percentage: 9.7 },
  ],
  bySubEntity: [
    { name: 'backend', cost: asDollars(22_000), percentage: 52 },
    { name: 'frontend', cost: asDollars(12_000), percentage: 28.4 },
    { name: 'shared', cost: asDollars(8_300.5), percentage: 19.6 },
  ],
};

const syncStatus: SyncStatus = { status: 'idle', lastSync: null };

const config: CostGoblinConfig = {
  providers: [{
    name: 'aws-main',
    type: 'aws',
    credentials: { profile: 'default' },
    sync: { daily: { bucket: asBucketPath('costgoblin-cur-bucket/daily'), retentionDays: 90 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'UnblendedCost', lagDays: 2 },
};

const mockDimensions: Dimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'line_item_usage_account_id', displayField: 'account_name' },
  { name: asDimensionId('service'), label: 'Service', field: 'product_service_name' },
  { name: asDimensionId('region'), label: 'Region', field: 'product_region' },
  { name: asDimensionId('resource'), label: 'Resource', field: 'line_item_resource_id' },
  { tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab', aliases: { platform: ['Platform', 'platform-eng', 'plt'], data: ['Data', 'data-eng', 'data-platform'] } },
  { tagName: 'env', label: 'Environment', concept: 'environment', normalize: 'lowercase', aliases: { prod: ['production', 'prd'], staging: ['stage', 'stg'] } },
  { tagName: 'product', label: 'Product', concept: 'product', normalize: 'lowercase-kebab' },
];

const orgTree: OrgNode[] = [
  {
    name: 'engineering',
    virtual: true,
    children: [
      { name: 'platform', children: [{ name: 'backend' }, { name: 'frontend' }, { name: 'shared' }] },
      { name: 'data', children: [{ name: 'analytics' }, { name: 'pipelines' }] },
      { name: 'ml', children: [{ name: 'training' }, { name: 'inference' }] },
    ],
  },
  { name: 'growth', children: [{ name: 'acquisition' }, { name: 'retention' }] },
  { name: 'infra', children: [{ name: 'networking' }, { name: 'security' }] },
];

export class MockCostApi implements CostApi {
  queryCosts(): Promise<CostResult> { return Promise.resolve(costResult); }
  queryDailyCosts(): Promise<DailyCostsResult> {
    const days = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(2026, 2, i + 1);
      const date = d.toISOString().slice(0, 10);
      return {
        date: asDateString(date),
        total: asDollars(3000 + Math.random() * 2000),
        breakdown: {
          platform: asDollars(1200 + Math.random() * 800),
          data: asDollars(900 + Math.random() * 600),
          growth: asDollars(500 + Math.random() * 400),
          infra: asDollars(300 + Math.random() * 200),
        },
      };
    });
    return Promise.resolve({
      days,
      groups: ['platform', 'data', 'growth', 'infra'],
      totalCost: asDollars(days.reduce((s, d) => s + d.total, 0)),
    });
  }
  queryTrends(): Promise<TrendResult> { return Promise.resolve(trendResult); }
  queryMissingTags(): Promise<MissingTagsResult> { return Promise.resolve(missingTagsResult); }
  querySavings(): Promise<SavingsResult> {
    return Promise.resolve({
      recommendations: [
        { accountId: '111111111111', accountName: 'Production', actionType: 'PurchaseReservedInstances', resourceType: 'RdsReservedInstances', summary: '10 db.t4g.micro MariaDB in eu-central-1', region: 'eu-central-1', monthlySavings: asDollars(3000), monthlyCost: asDollars(5500), savingsPercentage: 55, effort: 'VeryLow', resourceArn: '', currentDetails: '', recommendedDetails: '', currentSummary: '', restartNeeded: false, rollbackPossible: false, recommendationSource: 'CostExplorer' },
        { accountId: '222222222222', accountName: 'Staging', actionType: 'Delete', resourceType: 'EbsVolume', summary: 'Detach and delete unused volume', region: 'us-east-1', monthlySavings: asDollars(800), monthlyCost: asDollars(800), savingsPercentage: 100, effort: 'Low', resourceArn: 'arn:aws:ec2:us-east-1:222222222222:volume/vol-abc123', currentDetails: '{"ebsVolume":{"configuration":{"storage":{"type":"gp3","sizeInGb":1024}}}}', recommendedDetails: '', currentSummary: 'vol-abc123', restartNeeded: false, rollbackPossible: false, recommendationSource: 'ComputeOptimizer' },
        { accountId: '111111111111', accountName: 'Production', actionType: 'Rightsize', resourceType: 'Ec2Instance', summary: 'Downsize to t3.medium', region: 'eu-central-1', monthlySavings: asDollars(150), monthlyCost: asDollars(400), savingsPercentage: 37, effort: 'Medium', resourceArn: 'arn:aws:ec2:eu-central-1:111111111111:instance/i-xyz789', currentDetails: '{"ec2Instance":{"configuration":{"instance":{"type":"m5.xlarge"}}}}', recommendedDetails: '{"ec2Instance":{"configuration":{"instance":{"type":"t3.medium"}}}}', currentSummary: 'i-xyz789', restartNeeded: true, rollbackPossible: true, recommendationSource: 'ComputeOptimizer' },
      ],
      totalMonthlySavings: asDollars(3950),
    });
  }
  queryEntityDetail(): Promise<EntityDetailResult> { return Promise.resolve(entityDetailResult); }
  getSyncStatus(): Promise<SyncStatus> { return Promise.resolve(syncStatus); }
  getSyncLog(): Promise<readonly SyncLogLine[]> { return Promise.resolve([]); }
  subscribeSyncLog(): () => void { return () => undefined; }
  clearSyncLog(): Promise<void> { return Promise.resolve(); }
  getConfig(): Promise<CostGoblinConfig> { return Promise.resolve(config); }
  getDimensions(): Promise<Dimension[]> { return Promise.resolve(mockDimensions); }
  getOrgTree(): Promise<OrgNode[]> { return Promise.resolve(orgTree); }
  getFilterValues(): Promise<{ value: string; label: string; count: number }[]> { return Promise.resolve([]); }
  getDataInventory(): Promise<DataInventoryResult> { return Promise.resolve({ periods: [], totalRemoteSize: 0, totalLocalPeriods: 0, totalRemotePeriods: 0, lastSync: null, local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null } }); }
  syncPeriods(): Promise<{ filesDownloaded: number; rowsProcessed: number }> { return Promise.resolve({ filesDownloaded: 0, rowsProcessed: 0 }); }
  cancelSync(): Promise<void> { return Promise.resolve(); }
  deleteLocalPeriod(): Promise<void> { return Promise.resolve(); }
  openDataFolder(): Promise<void> { return Promise.resolve(); }
  ssoLogin(): Promise<void> { return Promise.resolve(); }
  getAccountMapping(): Promise<AccountMappingStatus> { return Promise.resolve({ status: 'missing' }); }
  getSetupStatus(): Promise<{ configured: boolean; postSetup: boolean }> { return Promise.resolve({ configured: true, postSetup: false }); }
  testConnection(): Promise<{ ok: boolean; error?: string | undefined }> { return Promise.resolve({ ok: true }); }
  listAwsProfiles(): Promise<string[]> { return Promise.resolve(['default', 'prod', 'staging']); }
  listS3Buckets(): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> { return Promise.resolve({ buckets: [{ name: 'my-cur-bucket', region: 'eu-central-1' }] }); }
  browseS3(): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> { return Promise.resolve({ prefixes: ['data', 'metadata'], isCurReport: true, detectedType: 'daily', missingColumns: [] }); }
  scaffoldConfig(): Promise<void> { return Promise.resolve(); }
  writeConfig(): Promise<void> { return Promise.resolve(); }
  updateAwsProfile(): Promise<void> { return Promise.resolve(); }
  getSavingsPreferences(): Promise<{ hiddenActionTypes: readonly string[] }> { return Promise.resolve({ hiddenActionTypes: [] }); }
  saveSavingsPreferences(): Promise<void> { return Promise.resolve(); }
  getUIPreferences(): Promise<{ theme: 'dark' | 'light'; palette: 'standard' | 'colorblind' }> { return Promise.resolve({ theme: 'dark', palette: 'standard' }); }
  saveUIPreferences(): Promise<void> { return Promise.resolve(); }
  syncOrgAccounts(): Promise<{ accounts: readonly never[]; orgId: string; syncedAt: string }> { return Promise.resolve({ accounts: [], orgId: 'mock', syncedAt: new Date().toISOString() }); }
  getOrgSyncResult(): Promise<null> { return Promise.resolve(null); }
  getOrgSyncProgress(): Promise<null> { return Promise.resolve(null); }
  getRegionNamesInfo(): Promise<null> { return Promise.resolve(null); }
  clearOrgData(): Promise<void> { return Promise.resolve(); }
  syncRegionNames(): Promise<{ count: number; syncedAt: string }> { return Promise.resolve({ count: 0, syncedAt: '' }); }
  discoverTagKeys(): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> { return Promise.resolve({ tags: [{ key: 'team', sampleValues: ['platform', 'payments'], rowCount: 500, distinctCount: 8, coveragePct: 45 }, { key: 'environment', sampleValues: ['production', 'staging'], rowCount: 400, distinctCount: 4, coveragePct: 36 }], samplePeriod: '2026-04' }); }
  discoverColumnValues(): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }> { return Promise.resolve({ values: [{ value: 'Usage', cost: 12345 }, { value: 'Tax', cost: 234 }, { value: 'Credit', cost: -100 }], distinctCount: 3, period: '2026-04' }); }
  getDimensionsConfig(): Promise<DimensionsConfig> { return Promise.resolve({ builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' }], tags: [{ tagName: 'team', label: 'Team', concept: 'owner' as const }] }); }
  saveDimensionsConfig(): Promise<void> { return Promise.resolve(); }
  estimateRollupGrain(candidate: DimensionsConfig): Promise<RollupGrainEstimate> {
    // Feed the real estimator a probe-shaped fixture so the mock matches the
    // shape and thresholds the desktop handler produces. resource_id (when
    // enabled) is near-unique → flagged; the others stay navigational.
    const enabled = (d: { enabled?: boolean | undefined }): boolean => d.enabled !== false;
    const hasResourceId = candidate.builtIn.some(d => d.field === 'resource_id' && enabled(d));
    const probeLineItems = 2_100_000;
    const probeGrainRows = hasResourceId ? 1_840_000 : 92_000;
    // leaveOneOutGrainRows = grain with that dim removed. With resource_id
    // enabled it dominates (removing it collapses the grain ~20×); the others
    // are near-redundant (loo ≈ full grain → ≈ ×1).
    const dimCardinalities = hasResourceId
      ? [
          { column: 'account_id', cardinality: 14, leaveOneOutGrainRows: 1_800_000 },
          { column: 'service', cardinality: 38, leaveOneOutGrainRows: 1_780_000 },
          { column: 'tag_team', cardinality: 22, leaveOneOutGrainRows: 1_820_000 },
          { column: 'resource_id', cardinality: 1_820_000, leaveOneOutGrainRows: 92_000 },
        ]
      : [
          { column: 'account_id', cardinality: 14, leaveOneOutGrainRows: 84_000 },
          { column: 'service', cardinality: 38, leaveOneOutGrainRows: 66_000 },
          { column: 'tag_team', cardinality: 22, leaveOneOutGrainRows: 88_000 },
        ];
    return Promise.resolve(computeRollupEstimate({
      probePeriod: '2026-04',
      months: 12,
      probeGrainRows,
      probeLineItems,
      rawBytes: 4_900_000_000,
      current: { rows: 1_100_000, bytes: 17_600_000 },
      // The built rollup (current) represents the navigational grain; toggling
      // resource_id ON changes the grain → estimate, OFF → matches → actuals.
      currentMatchesCandidate: !hasResourceId,
      dimCardinalities,
    }));
  }
  getAutoSyncEnabled(): Promise<boolean> { return Promise.resolve(false); }
  setAutoSyncEnabled(): Promise<void> { return Promise.resolve(); }
  getAutoSyncIntervalMinutes(): Promise<number> { return Promise.resolve(24 * 60); }
  setAutoSyncIntervalMinutes(): Promise<void> { return Promise.resolve(); }
  getAutoSyncStatus(): Promise<{ state: 'disabled' }> { return Promise.resolve({ state: 'disabled' }); }
  getAutoPruneEnabled(): Promise<boolean> { return Promise.resolve(false); }
  setAutoPruneEnabled(): Promise<void> { return Promise.resolve(); }
  pruneNow(): Promise<PruneResult> { return Promise.resolve({ deleted: [] }); }
  getViewsConfig(): Promise<ViewsConfig> { return Promise.resolve(MOCK_VIEWS_CONFIG); }
  saveViewsConfig(): Promise<void> { return Promise.resolve(); }
  resetViewsConfig(): Promise<ViewsConfig> { return Promise.resolve(MOCK_VIEWS_CONFIG); }
  revealViewsFolder(): Promise<void> { return Promise.resolve(); }
  getCostScope(): Promise<CostScopeConfig> { return Promise.resolve(DEFAULT_COST_SCOPE); }
  saveCostScope(): Promise<void> { return Promise.resolve(); }
  previewCostScope(): Promise<CostScopePreviewResult> {
    return Promise.resolve({
      windowDays: 30,
      startDate: '2026-03-20',
      endDate: '2026-04-18',
      perRule: [],
      combined: { excludedCost: 0, excludedRows: 0 },
      unscopedTotalCost: 0,
      scopedTotalCost: 0,
      dailyTotals: [],
      sampleRows: [],
      sampleTotalRowCount: 0,
      tagColumns: [],
    });
  }
  getCostScopeCapabilities(): Promise<CostScopeCapabilities> {
    return Promise.resolve({ hasEffectiveCostColumns: true, hasNetColumns: true, hasListPriceColumn: true });
  }
  revealCostScopeFolder(): Promise<void> { return Promise.resolve(); }
  queryExplorerOverview(): Promise<ExplorerOverviewResult> {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    const dailyTotals = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today.getTime() - (29 - i) * 86_400_000);
      return {
        date: d.toISOString().slice(0, 10),
        cost: 3_500 + Math.sin(i / 3) * 400 + Math.random() * 300,
        rows: 1_800 + Math.floor(Math.random() * 400),
      };
    });
    return Promise.resolve({
      windowDays: 30,
      startDate: start,
      endDate: end,
      dailyTotals,
      totalRows: 54_012,
      totalCost: dailyTotals.reduce((s, d) => s + d.cost, 0),
      tagColumns: [
        { id: 'tag_team', label: 'Team' },
        { id: 'tag_env', label: 'Environment' },
      ],
    });
  }
  queryExplorerRows(): Promise<ExplorerRowsResult> {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    const mockRows = [
      { date: end, hour: '', accountId: '111', accountName: 'prod-main', region: 'eu-central-1', service: 'Amazon EC2', serviceFamily: 'Compute', lineItemType: 'Usage', operation: 'RunInstances', usageType: 'EUC1-BoxUsage:t3.medium', description: '$0.0464 per On Demand Linux t3.medium Instance Hour', resourceId: 'i-0abc', usageAmount: 24, cost: 1_180.5, listCost: 1_200, tags: { tag_team: 'platform', tag_env: 'prod' } },
      { date: end, hour: '', accountId: '222', accountName: 'staging', region: 'us-east-1', service: 'Amazon RDS', serviceFamily: 'Database', lineItemType: 'Usage', operation: 'CreateDBInstance', usageType: 'RDS:db.t4g.micro', description: 'Aurora MySQL db.t4g.micro', resourceId: 'arn:rds:...', usageAmount: 12, cost: 420, listCost: 500, tags: { tag_team: 'data', tag_env: 'staging' } },
      { date: start, hour: '', accountId: '111', accountName: 'prod-main', region: 'eu-central-1', service: 'Amazon S3', serviceFamily: 'Storage', lineItemType: 'Usage', operation: 'PutObject', usageType: 'EUC1-Requests-Tier1', description: 'PUT requests', resourceId: 'arn:s3:::...', usageAmount: 12_000, cost: 3.6, listCost: 3.6, tags: { tag_team: 'platform', tag_env: 'prod' } },
    ];
    return Promise.resolve({
      sampleRows: mockRows,
      tagColumns: [
        { id: 'tag_team', label: 'Team' },
        { id: 'tag_env', label: 'Environment' },
      ],
    });
  }
  queryAggregatedTable(): Promise<import('@costgoblin/core/browser').AggregatedTableResult> {
    return Promise.resolve({
      rows: [
        { values: { service: 'Amazon EC2', region: 'eu-central-1' }, cost: 1_180.5, listCost: 1_200, usageAmount: 24, rowCount: 500 },
        { values: { service: 'Amazon RDS', region: 'us-east-1' }, cost: 420, listCost: 500, usageAmount: 12, rowCount: 200 },
      ],
      totalRows: 2,
      tagColumns: [{ id: 'tag_team', label: 'Team' }, { id: 'tag_env', label: 'Environment' }],
    });
  }
  getExplorerFilterValues(): Promise<ExplorerFilterValue[]> {
    return Promise.resolve([
      { value: 'Amazon EC2', label: 'Amazon EC2', cost: 18_000, rows: 8_400 },
      { value: 'Amazon RDS', label: 'Amazon RDS', cost: 9_500, rows: 3_200 },
      { value: 'Amazon S3', label: 'Amazon S3', cost: 6_200, rows: 12_800 },
      { value: 'AWS Lambda', label: 'AWS Lambda', cost: 4_100, rows: 1_200 },
    ]);
  }
  getExplorerPreferences(): Promise<{ hiddenColumns: readonly string[]; columnOrder: readonly string[] }> {
    return Promise.resolve({ hiddenColumns: [], columnOrder: [] });
  }
  saveExplorerPreferences(): Promise<void> { return Promise.resolve(); }
  getAliasSuggestions(tagName: string): Promise<AliasSuggestion[]> {
    const suggestions: Record<string, AliasSuggestion[]> = {
      'team': [
        { canonical: 'platform', aliases: ['Platform', 'platform-eng', 'plt'] },
        { canonical: 'data', aliases: ['Data', 'data-eng', 'data-platform'] },
      ],
      'env': [
        { canonical: 'prod', aliases: ['production', 'prd', 'PROD'] },
        { canonical: 'staging', aliases: ['stage', 'stg'] },
      ],
    };
    return Promise.resolve(suggestions[tagName] ?? []);
  }
  dismissSuggestion(): Promise<void> { return Promise.resolve(); }
  acceptSuggestion(): Promise<void> { return Promise.resolve(); }
  cancelPendingQueries(): Promise<void> { return Promise.resolve(); }
  clearAllCaches(): Promise<void> { return Promise.resolve(); }
  getPerformanceInfo(): Promise<PerformanceInfo> { return Promise.resolve({ defaultMemoryGB: 8, defaultThreads: 8, defaultRollupConcurrency: 2, totalMemoryGB: 16, maxThreads: 8, maxRollupConcurrency: 8, minMemoryGB: 1, maxMemoryGB: 24, current: { memoryLimitGB: null, threads: null, rollupConcurrency: null } }); }
  setPerformanceSettings(): Promise<void> { return Promise.resolve(); }
  awaitMaterializedBase(): Promise<boolean> { return Promise.resolve(true); }
  getMcpServerRunning(): Promise<boolean> { return Promise.resolve(true); }
  setMcpServerRunning(): Promise<void> { return Promise.resolve(); }
  getMcpToken(): Promise<string> { return Promise.resolve('mock-token-abc123'); }
  regenerateMcpToken(): Promise<string> { return Promise.resolve('mock-token-regenerated'); }
  listBaselines(): Promise<BaselinesListResult> {
    return Promise.resolve({
      items: [], totalPotentialMonthly: asDollars(0), totalRealizedMonthly: asDollars(0), total: 0,
      counts: { all: 0, open: 0, 'new': 0, tracking: 0, acting: 0, resolved: 0, dismissed: 0, ignored: 0 },
    });
  }
  getBaseline(): Promise<BaselineDetail | null> { return Promise.resolve(null); }
  createBaseline(input: BaselineCreateInput): Promise<BaselineRecord> {
    return Promise.resolve({
      spec: { id: 'mock', source: 'manual', scope: input.scope, basis: { costMetric: 'amortized', costPerspective: 'gross', rules: [] }, basisSnapshotAt: '', createdAt: '', updatedAt: '' },
      stats: null,
      current: null,
      savings: { potentialDaily: asDollars(0), realizedDaily: asDollars(0), potentialMonthly: asDollars(0), realizedMonthly: asDollars(0) },
      status: 'insufficient-data',
      triageStatus: 'new',
      effectiveLower: asDollars(0),
      effectiveUpper: asDollars(0),
      currentDaily: asDollars(0),
      potentialDaily: asDollars(0),
      realizedDaily: asDollars(0),
      bestAchieved: null,
      scopeLabel: 'mock',
      triage: { notes: [] },
    });
  }
  updateBaseline(): Promise<BaselineRecord | null> { return Promise.resolve(null); }
  deleteBaseline(): Promise<void> { return Promise.resolve(); }
  recomputeBaselines(): Promise<void> { return Promise.resolve(); }
  getBaselineSnapshots(): Promise<readonly BaselineSnapshot[]> { return Promise.resolve([]); }
  getBaselineDrift(): Promise<readonly BaselineDriftRow[]> { return Promise.resolve([]); }
  getBaselinesConfig(): Promise<BaselinesConfigState> {
    return Promise.resolve({ config: this.mockBaselinesConfig(), isCustom: false });
  }
  setBaselinesConfig(config: BaselinesDiscoveryConfig): Promise<BaselinesConfigState> {
    return Promise.resolve({ config, isCustom: true });
  }
  resetBaselinesConfig(): Promise<BaselinesConfigState> {
    return Promise.resolve({ config: this.mockBaselinesConfig(), isCustom: false });
  }
  private mockBaselinesConfig(): BaselinesDiscoveryConfig {
    return { lookbackDays: 365, windowDays: 30, lowerPct: 10, upperPct: 90, minMonthlyCost: asDollars(100), minSavings: asDollars(0), reopenPct: 15, grainDimensions: [] };
  }
  getTelemetryPreferences(): Promise<TelemetryPreferences> { return Promise.resolve({ errorReports: false, nativeCrashReports: false, performance: false, analytics: false }); }
  setTelemetryPreferences(): Promise<void> { return Promise.resolve(); }
  getTelemetryStatus(): Promise<TelemetryStatus> { return Promise.resolve({ dsnConfigured: false, active: false, preferences: { errorReports: false, nativeCrashReports: false, performance: false, analytics: false }, armed: { errorReports: false, nativeCrashReports: false, performance: false, analytics: false } }); }
  getTelemetryOutbox(): Promise<readonly TelemetryOutboxEntry[]> { return Promise.resolve([]); }
  exportConfigBundle(): Promise<ExportConfigBundleResult> {
    return Promise.resolve({ status: 'saved', path: '/mock/costgoblin-config-2026-06-11.yaml' });
  }
  previewConfigBundleFile(): Promise<PreviewConfigBundleResult> {
    return Promise.resolve({ status: 'ok', content: 'kind: costgoblin-config-bundle', summary: MOCK_BUNDLE_SUMMARY });
  }
  // Property-style so the declared type keeps the params (see
  // checkConfigBeacon below).
  fetchConfigBundleFromS3: (params: { profile: string; location: string }) => Promise<PreviewConfigBundleResult> =
    () => Promise.resolve({ status: 'ok', content: 'kind: costgoblin-config-bundle', summary: MOCK_BUNDLE_SUMMARY });
  applyConfigBundle(): Promise<ApplyConfigBundleResult> {
    return Promise.resolve({ status: 'applied', sections: ['config', 'dimensions', 'orgTree', 'costScope', 'views'], backupDir: null });
  }
  // Property-style so the declared type keeps the params (see
  // checkConfigBeacon below).
  publishConfigBundle: (params?: { location?: string | undefined; profile?: string | undefined }) => Promise<PublishConfigBundleResult> =
    (params) => Promise.resolve({ status: 'published', location: params?.location ?? 's3://my-cur-bucket/costgoblin/org-config.yaml' });
  // Property-style so the declared type keeps the params even though this
  // default implementation ignores them — tests override with param-aware
  // functions.
  checkConfigBeacon: (params: CheckConfigBeaconParams) => Promise<CheckConfigBeaconResult> =
    () => Promise.resolve({ status: 'none' });
  getDataSharingStatus(): Promise<DataSharingStatus> {
    return Promise.resolve({ enabled: false, sharingKey: null, label: 'Mock · CostGoblin', port: null, hosts: [], fingerprint: 'ABCD-EF01-2345-6789', lastServedAt: null, filesServed: 0, lastPeer: null, bytesServed: 0, connectedClients: 0, bytesPerSecond: 0 });
  }
  enableDataSharing(): Promise<DataSharingResult> {
    return Promise.resolve({ status: 'ok', sharing: { enabled: true, sharingKey: 'CGSHARE1-mock-sharing-key', label: 'Mock · CostGoblin', port: 53178, hosts: [MOCK_PEER_HOST], fingerprint: 'ABCD-EF01-2345-6789', lastServedAt: null, filesServed: 0, lastPeer: null, bytesServed: 0, connectedClients: 0, bytesPerSecond: 0 } });
  }
  disableDataSharing(): Promise<DataSharingResult> {
    return Promise.resolve({ status: 'ok', sharing: { enabled: false, sharingKey: null, label: 'Mock · CostGoblin', port: null, hosts: [], fingerprint: 'ABCD-EF01-2345-6789', lastServedAt: null, filesServed: 0, lastPeer: null, bytesServed: 0, connectedClients: 0, bytesPerSecond: 0 } });
  }
  rotateDataSharingKey(): Promise<DataSharingResult> {
    return Promise.resolve({ status: 'ok', sharing: { enabled: true, sharingKey: 'CGSHARE1-rotated-key', label: 'Mock · CostGoblin', port: 53178, hosts: [MOCK_PEER_HOST], fingerprint: 'ABCD-EF01-2345-6789', lastServedAt: null, filesServed: 0, lastPeer: null, bytesServed: 0, connectedClients: 0, bytesPerSecond: 0 } });
  }
  getSharedPullProgress(): Promise<SharedPullProgress> {
    return Promise.resolve({ active: false, phase: 'idle', filesDone: 0, filesTotal: 0, currentPeriod: null, bytesDone: 0, bytesTotal: 0, error: null });
  }
  // Property-style so the declared type keeps the params (see checkConfigBeacon).
  previewSharedSource: (key: string) => Promise<PreviewSharedSourceResult> =
    () => Promise.resolve({ status: 'ok', preview: MOCK_SHARED_SOURCE_PREVIEW });
  previewStoredSource(): Promise<PreviewSharedSourceResult> {
    return Promise.resolve({ status: 'ok', preview: MOCK_SHARED_SOURCE_PREVIEW });
  }
  addSharedSource: (key: string, selection?: SharedPullSelection) => Promise<PullSharedSourceResult> =
    () => Promise.resolve({ status: 'ok', source: MOCK_SHARED_SOURCE, filesDownloaded: 3 });
  getSharedSource(): Promise<SharedSourceInfo | null> {
    return Promise.resolve(null);
  }
  refreshSharedSource: (selection?: SharedPullSelection) => Promise<PullSharedSourceResult> =
    () => Promise.resolve({ status: 'ok', source: MOCK_SHARED_SOURCE, filesDownloaded: 0 });
  removeSharedSource(): Promise<void> {
    return Promise.resolve();
  }
}

export const MOCK_SHARED_SOURCE: SharedSourceInfo = {
  label: 'Etienne · CostGoblin',
  fingerprint: 'ABCD-EF01-2345-6789',
  host: MOCK_PEER_HOST,
  port: 53178,
  lastPulledAt: '2026-06-21T09:00:00.000Z',
  periods: ['2026-05', '2026-06'],
};

export const MOCK_SHARED_SOURCE_PREVIEW: SharedSourcePreview = {
  label: 'Etienne · CostGoblin',
  fingerprint: 'ABCD-EF01-2345-6789',
  hasConfig: true,
  configSummary: null,
  tiers: [
    { tier: 'daily', periods: ['2026-04', '2026-05', '2026-06'], fileCount: 6, bytes: 24_000_000 },
    { tier: 'hourly', periods: ['2026-05', '2026-06'], fileCount: 4, bytes: 80_000_000 },
    { tier: 'cost-optimization', periods: ['2026-06'], fileCount: 1, bytes: 1_200_000 },
  ],
};

export const MOCK_BUNDLE_SUMMARY: ConfigBundleSummary = {
  schemaVersion: 1,
  appVersion: '0.2.0',
  exportedAt: '2026-06-01T09:00:00.000Z',
  fingerprint: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  fingerprintValid: true,
  sections: ['config', 'dimensions', 'orgTree', 'costScope', 'views'],
  providers: [{ name: 'aws-main', dailyBucket: 's3://my-cur-bucket/daily/' }],
  builtInDimensionCount: 7,
  tagDimensionCount: 3,
  orgTreeNodeCount: 12,
  exclusionRuleCount: 6,
  viewCount: 2,
  baselineCount: 0,
};

const MOCK_VIEWS_CONFIG: ViewsConfig = {
  views: [
    {
      id: 'overview',
      name: 'Cost Overview',
      builtIn: true,
      rows: [
        {
          widgets: [
            { id: 'm-summary', type: 'summary', size: 'small', metric: 'total' },
            { id: 'm-hist', type: 'stackedBar', size: 'large', groupBy: asDimensionId('service') },
          ],
        },
        {
          widgets: [
            { id: 'm-pie-account', type: 'pie', size: 'medium', groupBy: asDimensionId('account') },
            { id: 'm-pie-region', type: 'pie', size: 'medium', groupBy: asDimensionId('region') },
            { id: 'm-pie-service', type: 'pie', size: 'medium', groupBy: asDimensionId('service') },
          ],
        },
      ],
    },
  ],
};
