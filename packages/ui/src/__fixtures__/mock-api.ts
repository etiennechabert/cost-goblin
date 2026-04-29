import {
  asBucketPath,
  asDimensionId,
  asDollars,
  asDateString,
  asEntityRef,
  type AccountMappingStatus,
  type CostApi,
  type CostResult,
  type DailyCostsResult,
  type DataInventoryResult,
  type Dimension,
  type EntityDetailResult,
  type MissingTagsResult,
  type OrgNode,
  type SavingsResult,
  type SyncStatus,
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
  private readonly errorMode: ErrorMode;
  private readonly customErrors: Partial<Record<keyof CostApi, Error>>;

  constructor(options: MockCostApiOptions = {}) {
    this.errorMode = options.errorMode ?? 'none';
    this.customErrors = options.customErrors ?? {};
  }

  static withNetworkError(): MockCostApi {
    return new MockCostApi({ errorMode: 'network' });
  }

  static withEmptyData(): MockCostApi {
    return new MockCostApi({ errorMode: 'empty' });
  }

  static withMethodError(method: keyof CostApi, error: Error): MockCostApi {
    return new MockCostApi({ customErrors: { [method]: error } });
  }

  static withDatabaseError(): MockCostApi {
    const error = new Error('Database error: Failed to execute query');
    return new MockCostApi({ customErrors: { queryCosts: error } });
  }

  static withTimeoutError(): MockCostApi {
    const error = new Error('Timeout error: Query exceeded maximum execution time');
    return new MockCostApi({ customErrors: { queryCosts: error } });
  }

  static withPermissionError(): MockCostApi {
    const error = new Error('Permission error: Insufficient privileges to access data');
    return new MockCostApi({ customErrors: { queryCosts: error } });
  }

  private checkError(method: keyof CostApi): void {
    const customError = this.customErrors[method];
    if (customError !== undefined) {
      throw customError;
    }
    if (this.errorMode === 'network') {
      throw new Error('Network error: Failed to connect to service');
    }
  }

  queryCosts(): Promise<CostResult> {
    this.checkError('queryCosts');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        rows: [],
        totalCost: asDollars(0),
        topServices: [],
        dateRange: { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') },
      });
    }
    return Promise.resolve(costResult);
  }
  queryDailyCosts(): Promise<DailyCostsResult> {
    this.checkError('queryDailyCosts');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        days: [],
        groups: [],
        totalCost: asDollars(0),
      });
    }
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
  queryTrends(): Promise<TrendResult> {
    this.checkError('queryTrends');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        increases: [],
        savings: [],
        totalIncrease: asDollars(0),
        totalSavings: asDollars(0),
      });
    }
    return Promise.resolve(trendResult);
  }
  queryMissingTags(): Promise<MissingTagsResult> {
    this.checkError('queryMissingTags');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        rows: [],
        totalActionableCost: asDollars(0),
        totalLikelyUntaggableCost: asDollars(0),
        totalNonResourceCost: asDollars(0),
        actionableCount: 0,
        likelyUntaggableCount: 0,
        nonResourceRows: [],
      });
    }
    return Promise.resolve(missingTagsResult);
  }
  querySavings(): Promise<SavingsResult> {
    this.checkError('querySavings');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        recommendations: [],
        totalMonthlySavings: asDollars(0),
      });
    }
    return Promise.resolve({
      recommendations: [
        { accountId: '111111111111', accountName: 'Production', actionType: 'PurchaseReservedInstances', resourceType: 'RdsReservedInstances', summary: '10 db.t4g.micro MariaDB in eu-central-1', region: 'eu-central-1', monthlySavings: asDollars(3000), monthlyCost: asDollars(5500), savingsPercentage: 55, effort: 'VeryLow', resourceArn: '', currentDetails: '', recommendedDetails: '', currentSummary: '', restartNeeded: false, rollbackPossible: false, recommendationSource: 'CostExplorer' },
        { accountId: '222222222222', accountName: 'Staging', actionType: 'Delete', resourceType: 'EbsVolume', summary: 'Detach and delete unused volume', region: 'us-east-1', monthlySavings: asDollars(800), monthlyCost: asDollars(800), savingsPercentage: 100, effort: 'Low', resourceArn: 'arn:aws:ec2:us-east-1:222222222222:volume/vol-abc123', currentDetails: '{"ebsVolume":{"configuration":{"storage":{"type":"gp3","sizeInGb":1024}}}}', recommendedDetails: '', currentSummary: 'vol-abc123', restartNeeded: false, rollbackPossible: false, recommendationSource: 'ComputeOptimizer' },
        { accountId: '111111111111', accountName: 'Production', actionType: 'Rightsize', resourceType: 'Ec2Instance', summary: 'Downsize to t3.medium', region: 'eu-central-1', monthlySavings: asDollars(150), monthlyCost: asDollars(400), savingsPercentage: 37, effort: 'Medium', resourceArn: 'arn:aws:ec2:eu-central-1:111111111111:instance/i-xyz789', currentDetails: '{"ec2Instance":{"configuration":{"instance":{"type":"m5.xlarge"}}}}', recommendedDetails: '{"ec2Instance":{"configuration":{"instance":{"type":"t3.medium"}}}}', currentSummary: 'i-xyz789', restartNeeded: true, rollbackPossible: true, recommendationSource: 'ComputeOptimizer' },
      ],
      totalMonthlySavings: asDollars(3950),
    });
  }
  queryEntityDetail(): Promise<EntityDetailResult> {
    this.checkError('queryEntityDetail');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        entity: asEntityRef(''),
        totalCost: asDollars(0),
        previousCost: asDollars(0),
        percentChange: 0,
        dailyCosts: [],
        byAccount: [],
        byService: [],
        bySubEntity: [],
      });
    }
    return Promise.resolve(entityDetailResult);
  }
  getSyncStatus(): Promise<SyncStatus> {
    this.checkError('getSyncStatus');
    return Promise.resolve(syncStatus);
  }
  getConfig(): Promise<CostGoblinConfig> {
    this.checkError('getConfig');
    return Promise.resolve(config);
  }
  getDimensions(): Promise<Dimension[]> {
    this.checkError('getDimensions');
    if (this.errorMode === 'empty') {
      return Promise.resolve([]);
    }
    return Promise.resolve(mockDimensions);
  }
  getOrgTree(): Promise<OrgNode[]> {
    this.checkError('getOrgTree');
    if (this.errorMode === 'empty') {
      return Promise.resolve([]);
    }
    return Promise.resolve(orgTree);
  }
  getFilterValues(): Promise<{ value: string; label: string; count: number }[]> {
    this.checkError('getFilterValues');
    return Promise.resolve([]);
  }
  getDataInventory(): Promise<DataInventoryResult> {
    this.checkError('getDataInventory');
    return Promise.resolve({ periods: [], totalRemoteSize: 0, totalLocalPeriods: 0, totalRemotePeriods: 0, local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null } });
  }
  syncPeriods(): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
    this.checkError('syncPeriods');
    return Promise.resolve({ filesDownloaded: 0, rowsProcessed: 0 });
  }
  cancelSync(): Promise<void> {
    this.checkError('cancelSync');
    return Promise.resolve();
  }
  deleteLocalPeriod(): Promise<void> {
    this.checkError('deleteLocalPeriod');
    return Promise.resolve();
  }
  openDataFolder(): Promise<void> {
    this.checkError('openDataFolder');
    return Promise.resolve();
  }
  getAccountMapping(): Promise<AccountMappingStatus> {
    this.checkError('getAccountMapping');
    return Promise.resolve({ status: 'missing' });
  }
  getSetupStatus(): Promise<{ configured: boolean }> {
    this.checkError('getSetupStatus');
    return Promise.resolve({ configured: true });
  }
  testConnection(): Promise<{ ok: boolean; error?: string | undefined }> {
    this.checkError('testConnection');
    return Promise.resolve({ ok: true });
  }
  listAwsProfiles(): Promise<string[]> {
    this.checkError('listAwsProfiles');
    if (this.errorMode === 'empty') {
      return Promise.resolve([]);
    }
    return Promise.resolve(['default', 'prod', 'staging']);
  }
  listS3Buckets(): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> {
    this.checkError('listS3Buckets');
    if (this.errorMode === 'empty') {
      return Promise.resolve({ buckets: [] });
    }
    return Promise.resolve({ buckets: [{ name: 'my-cur-bucket', region: 'eu-central-1' }] });
  }
  browseS3(): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> {
    this.checkError('browseS3');
    if (this.errorMode === 'empty') {
      return Promise.resolve({ prefixes: [], isCurReport: false, detectedType: 'unknown', missingColumns: [] });
    }
    return Promise.resolve({ prefixes: ['data', 'metadata'], isCurReport: true, detectedType: 'daily', missingColumns: [] });
  }
  scaffoldConfig(): Promise<void> {
    this.checkError('scaffoldConfig');
    return Promise.resolve();
  }
  writeConfig(): Promise<void> {
    this.checkError('writeConfig');
    return Promise.resolve();
  }
  updateAwsProfile(): Promise<void> {
    this.checkError('updateAwsProfile');
    return Promise.resolve();
  }
  getSavingsPreferences(): Promise<{ hiddenActionTypes: readonly string[] }> {
    this.checkError('getSavingsPreferences');
    return Promise.resolve({ hiddenActionTypes: [] });
  }
  saveSavingsPreferences(): Promise<void> {
    this.checkError('saveSavingsPreferences');
    return Promise.resolve();
  }
  getUIPreferences(): Promise<{ theme: 'dark' | 'light'; palette: 'standard' | 'colorblind' }> {
    this.checkError('getUIPreferences');
    return Promise.resolve({ theme: 'dark', palette: 'standard' });
  }
  saveUIPreferences(): Promise<void> {
    this.checkError('saveUIPreferences');
    return Promise.resolve();
  }
  syncOrgAccounts(): Promise<{ accounts: readonly never[]; orgId: string; syncedAt: string }> {
    this.checkError('syncOrgAccounts');
    return Promise.resolve({ accounts: [], orgId: 'mock', syncedAt: new Date().toISOString() });
  }
  getOrgSyncResult(): Promise<null> {
    this.checkError('getOrgSyncResult');
    return Promise.resolve(null);
  }
  getOrgSyncProgress(): Promise<null> {
    this.checkError('getOrgSyncProgress');
    return Promise.resolve(null);
  }
  getRegionNamesInfo(): Promise<null> {
    this.checkError('getRegionNamesInfo');
    return Promise.resolve(null);
  }
  clearOrgData(): Promise<void> {
    this.checkError('clearOrgData');
    return Promise.resolve();
  }
  syncRegionNames(): Promise<{ count: number; syncedAt: string }> {
    this.checkError('syncRegionNames');
    return Promise.resolve({ count: 0, syncedAt: '' });
  }
  discoverTagKeys(): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> {
    this.checkError('discoverTagKeys');
    if (this.errorMode === 'empty') {
      return Promise.resolve({ tags: [], samplePeriod: '' });
    }
    return Promise.resolve({ tags: [{ key: 'team', sampleValues: ['platform', 'payments'], rowCount: 500, distinctCount: 8, coveragePct: 45 }, { key: 'environment', sampleValues: ['production', 'staging'], rowCount: 400, distinctCount: 4, coveragePct: 36 }], samplePeriod: '2026-04' });
  }
  discoverColumnValues(): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }> {
    this.checkError('discoverColumnValues');
    if (this.errorMode === 'empty') {
      return Promise.resolve({ values: [], distinctCount: 0, period: '' });
    }
    return Promise.resolve({ values: [{ value: 'Usage', cost: 12345 }, { value: 'Tax', cost: 234 }, { value: 'Credit', cost: -100 }], distinctCount: 3, period: '2026-04' });
  }
  getDimensionsConfig(): Promise<DimensionsConfig> {
    this.checkError('getDimensionsConfig');
    if (this.errorMode === 'empty') {
      return Promise.resolve({ builtIn: [], tags: [] });
    }
    return Promise.resolve({ builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' }], tags: [{ tagName: 'team', label: 'Team', concept: 'owner' as const }] });
  }
  saveDimensionsConfig(): Promise<void> {
    this.checkError('saveDimensionsConfig');
    return Promise.resolve();
  }
  getAutoSyncEnabled(): Promise<boolean> {
    this.checkError('getAutoSyncEnabled');
    return Promise.resolve(false);
  }
  setAutoSyncEnabled(): Promise<void> {
    this.checkError('setAutoSyncEnabled');
    return Promise.resolve();
  }
  getAutoSyncIntervalMinutes(): Promise<number> {
    this.checkError('getAutoSyncIntervalMinutes');
    return Promise.resolve(24 * 60);
  }
  setAutoSyncIntervalMinutes(): Promise<void> {
    this.checkError('setAutoSyncIntervalMinutes');
    return Promise.resolve();
  }
  getAutoSyncStatus(): Promise<{ state: 'disabled' }> {
    this.checkError('getAutoSyncStatus');
    return Promise.resolve({ state: 'disabled' });
  }
  getViewsConfig(): Promise<ViewsConfig> {
    this.checkError('getViewsConfig');
    if (this.errorMode === 'empty') {
      return Promise.resolve({ views: [] });
    }
    return Promise.resolve(MOCK_VIEWS_CONFIG);
  }
  saveViewsConfig(): Promise<void> {
    this.checkError('saveViewsConfig');
    return Promise.resolve();
  }
  resetViewsConfig(): Promise<ViewsConfig> {
    this.checkError('resetViewsConfig');
    if (this.errorMode === 'empty') {
      return Promise.resolve({ views: [] });
    }
    return Promise.resolve(MOCK_VIEWS_CONFIG);
  }
  revealViewsFolder(): Promise<void> {
    this.checkError('revealViewsFolder');
    return Promise.resolve();
  }
  getCostScope(): Promise<CostScopeConfig> {
    this.checkError('getCostScope');
    return Promise.resolve(DEFAULT_COST_SCOPE);
  }
  saveCostScope(): Promise<void> {
    this.checkError('saveCostScope');
    return Promise.resolve();
  }
  previewCostScope(): Promise<CostScopePreviewResult> {
    this.checkError('previewCostScope');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        windowDays: 30,
        startDate: '',
        endDate: '',
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
    this.checkError('getCostScopeCapabilities');
    return Promise.resolve({ hasEffectiveCostColumns: true, hasBlendedColumn: true, hasNetColumns: true });
  }
  revealCostScopeFolder(): Promise<void> {
    this.checkError('revealCostScopeFolder');
    return Promise.resolve();
  }
  queryExplorerOverview(): Promise<ExplorerOverviewResult> {
    this.checkError('queryExplorerOverview');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        windowDays: 30,
        startDate: '',
        endDate: '',
        dailyTotals: [],
        totalRows: 0,
        totalCost: 0,
        tagColumns: [],
      });
    }
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
    this.checkError('queryExplorerRows');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        sampleRows: [],
        tagColumns: [],
      });
    }
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
    this.checkError('queryAggregatedTable');
    if (this.errorMode === 'empty') {
      return Promise.resolve({
        rows: [],
        totalRows: 0,
        tagColumns: [],
      });
    }
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
    this.checkError('getExplorerFilterValues');
    if (this.errorMode === 'empty') {
      return Promise.resolve([]);
    }
    return Promise.resolve([
      { value: 'Amazon EC2', label: 'Amazon EC2', cost: 18_000, rows: 8_400 },
      { value: 'Amazon RDS', label: 'Amazon RDS', cost: 9_500, rows: 3_200 },
      { value: 'Amazon S3', label: 'Amazon S3', cost: 6_200, rows: 12_800 },
      { value: 'AWS Lambda', label: 'AWS Lambda', cost: 4_100, rows: 1_200 },
    ]);
  }
  getExplorerPreferences(): Promise<{ hiddenColumns: readonly string[]; columnOrder: readonly string[] }> {
    this.checkError('getExplorerPreferences');
    return Promise.resolve({ hiddenColumns: [], columnOrder: [] });
  }
  saveExplorerPreferences(): Promise<void> {
    this.checkError('saveExplorerPreferences');
    return Promise.resolve();
  }
  getAliasSuggestions(tagName: string): Promise<AliasSuggestion[]> {
    this.checkError('getAliasSuggestions');
    if (this.errorMode === 'empty') {
      return Promise.resolve([]);
    }
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
  dismissSuggestion(): Promise<void> {
    this.checkError('dismissSuggestion');
    return Promise.resolve();
  }
  acceptSuggestion(): Promise<void> {
    this.checkError('acceptSuggestion');
    return Promise.resolve();
  }
  cancelPendingQueries(): Promise<void> {
    this.checkError('cancelPendingQueries');
    return Promise.resolve();
  }
}

type ErrorMode = 'none' | 'network' | 'empty';

interface MockCostApiOptions {
  errorMode?: ErrorMode;
  customErrors?: Partial<Record<keyof CostApi, Error>>;
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
            { id: 'm-pie-service', type: 'pie', size: 'medium', groupBy: asDimensionId('service') },
          ],
        },
      ],
    },
  ],
};
