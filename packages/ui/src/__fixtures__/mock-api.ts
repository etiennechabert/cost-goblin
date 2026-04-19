import {
  asBucketPath,
  asDimensionId,
  asDollars,
  asDateString,
  asEntityRef,
} from '@costgoblin/core/browser';
import type {
  AccountMappingStatus,
  CostApi,
  CostResult,
  DailyCostsResult,
  DataInventoryResult,
  Dimension,
  EntityDetailResult,
  MissingTagsResult,
  OrgNode,
  SavingsResult,
  SyncStatus,
  TrendResult,
  CostGoblinConfig,
  DimensionsConfig,
  ViewsConfig,
  CostScopeConfig,
  CostScopePreviewResult,
} from '@costgoblin/core/browser';
import { DEFAULT_COST_SCOPE } from '@costgoblin/core/browser';

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
  totalActionableCost: asDollars(2_070),
  totalLikelyUntaggableCost: asDollars(340),
  totalNonResourceCost: asDollars(150),
  actionableCount: 2,
  likelyUntaggableCount: 1,
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
  getConfig(): Promise<CostGoblinConfig> { return Promise.resolve(config); }
  getDimensions(): Promise<Dimension[]> { return Promise.resolve(mockDimensions); }
  getOrgTree(): Promise<OrgNode[]> { return Promise.resolve(orgTree); }
  getFilterValues(): Promise<{ value: string; label: string; count: number }[]> { return Promise.resolve([]); }
  getDataInventory(): Promise<DataInventoryResult> { return Promise.resolve({ periods: [], totalRemoteSize: 0, totalLocalPeriods: 0, totalRemotePeriods: 0, local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null } }); }
  syncPeriods(): Promise<{ filesDownloaded: number; rowsProcessed: number }> { return Promise.resolve({ filesDownloaded: 0, rowsProcessed: 0 }); }
  cancelSync(): Promise<void> { return Promise.resolve(); }
  deleteLocalPeriod(): Promise<void> { return Promise.resolve(); }
  openDataFolder(): Promise<void> { return Promise.resolve(); }
  getAccountMapping(): Promise<AccountMappingStatus> { return Promise.resolve({ status: 'missing' }); }
  getSetupStatus(): Promise<{ configured: boolean }> { return Promise.resolve({ configured: true }); }
  testConnection(): Promise<{ ok: boolean; error?: string | undefined }> { return Promise.resolve({ ok: true }); }
  listAwsProfiles(): Promise<string[]> { return Promise.resolve(['default', 'prod', 'staging']); }
  listS3Buckets(): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> { return Promise.resolve({ buckets: [{ name: 'my-cur-bucket', region: 'eu-central-1' }] }); }
  browseS3(): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> { return Promise.resolve({ prefixes: ['data', 'metadata'], isCurReport: true, detectedType: 'daily', missingColumns: [] }); }
  scaffoldConfig(): Promise<void> { return Promise.resolve(); }
  writeConfig(): Promise<void> { return Promise.resolve(); }
  updateAwsProfile(): Promise<void> { return Promise.resolve(); }
  getSavingsPreferences(): Promise<{ hiddenActionTypes: readonly string[] }> { return Promise.resolve({ hiddenActionTypes: [] }); }
  saveSavingsPreferences(): Promise<void> { return Promise.resolve(); }
  getUIPreferences(): Promise<{ theme: 'dark' | 'light' }> { return Promise.resolve({ theme: 'dark' }); }
  saveUIPreferences(): Promise<void> { return Promise.resolve(); }
  getFileActivity(): Promise<[]> { return Promise.resolve([]); }
  getOptimizeStatus(): Promise<{ queued: number; running: boolean }> { return Promise.resolve({ queued: 0, running: false }); }
  getOptimizeEnabled(): Promise<boolean> { return Promise.resolve(true); }
  setOptimizeEnabled(): Promise<void> { return Promise.resolve(); }
  clearSidecars(): Promise<{ removed: number; requeued: number }> { return Promise.resolve({ removed: 0, requeued: 0 }); }
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
  getAutoSyncEnabled(): Promise<boolean> { return Promise.resolve(false); }
  setAutoSyncEnabled(): Promise<void> { return Promise.resolve(); }
  getAutoSyncStatus(): Promise<{ state: 'disabled' }> { return Promise.resolve({ state: 'disabled' }); }
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
    });
  }
  revealCostScopeFolder(): Promise<void> { return Promise.resolve(); }
}

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
            { id: 'm-pie-service', type: 'pie', size: 'medium', groupBy: asDimensionId('service'), drillable: true },
          ],
        },
      ],
    },
  ],
};
