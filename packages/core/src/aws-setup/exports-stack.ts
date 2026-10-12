import { DEFAULT_RETENTION_DAYS } from '../sync/retention.js';
import { isStringRecord } from '../utils/json.js';

// The CloudFormation stack that sets up a new account's billing data for
// CostGoblin: a bucket with its lifecycle rules, AWS Data Exports for FOCUS 1.2
// (daily, optional hourly) and Cost Optimization Hub (optional), and a
// read-only policy to grant CostGoblin. See docs/aws-one-click-setup-design.md.
//
// The template is built as plain data with long-form intrinsics ({ Ref: … },
// { 'Fn::Sub': … }) rather than YAML short tags, so tests can inspect it and
// the setup wizard can bake its answers in as parameter defaults.

/** A CloudFormation template value: JSON, with intrinsics as objects. */
export type TemplateValue = string | number | boolean | readonly TemplateValue[] | TemplateObject;
export interface TemplateObject { readonly [key: string]: TemplateValue }

/** Where each export lands. Data Exports appends the export's name, so the
 *  daily export's files are under `costgoblin/daily/costgoblin-daily/data/`. */
export const EXPORTS_STACK_LAYOUT = {
  daily: { exportName: 'costgoblin-daily', prefix: 'costgoblin/daily' },
  hourly: { exportName: 'costgoblin-hourly', prefix: 'costgoblin/hourly' },
  costOptimization: { exportName: 'costgoblin-cost-optimization', prefix: 'costgoblin/cost-optimization' },
} as const;

export type ExportsStackTier = keyof typeof EXPORTS_STACK_LAYOUT;

/** The stack's name in the console unless the user picks another. */
export const EXPORTS_STACK_NAME = 'costgoblin-exports';

/** The stack's parameters, by the name the console (and a quick-create link's
 *  `param_<Name>`) uses. */
export const EXPORTS_STACK_PARAMETERS = {
  bucketName: 'BucketName',
  daily: 'CreateDailyExport',
  hourly: 'CreateHourlyExport',
  costOptimization: 'CreateCostOptimizationExport',
  serviceRole: 'CreateDataExportsServiceRole',
  dailyExpirationDays: 'DailyExpirationDays',
  hourlyExpirationDays: 'HourlyExpirationDays',
  costOptimizationExpirationDays: 'CostOptimizationExpirationDays',
} as const;

/** Every column of `FOCUS_1_2_AWS`: Data Exports' SQL has no `SELECT *`. The
 *  list AWS's own Cloud Intelligence Dashboards template exports; it is a
 *  superset of the committed AWS sample (`__fixtures__/focus-1-2/samples`). */
export const FOCUS_1_2_AWS_COLUMNS = [
  'AvailabilityZone', 'BilledCost', 'BillingAccountId', 'BillingAccountName', 'BillingAccountType',
  'BillingCurrency', 'BillingPeriodEnd', 'BillingPeriodStart', 'CapacityReservationId',
  'CapacityReservationStatus', 'ChargeCategory', 'ChargeClass', 'ChargeDescription', 'ChargeFrequency',
  'ChargePeriodEnd', 'ChargePeriodStart', 'CommitmentDiscountCategory', 'CommitmentDiscountId',
  'CommitmentDiscountName', 'CommitmentDiscountQuantity', 'CommitmentDiscountType',
  'CommitmentDiscountUnit', 'CommitmentDiscountStatus', 'ConsumedQuantity', 'ConsumedUnit',
  'ContractedCost', 'ContractedUnitPrice', 'EffectiveCost', 'InvoiceId', 'InvoiceIssuerName', 'ListCost',
  'ListUnitPrice', 'PricingCategory', 'PricingCurrency', 'PricingCurrencyContractedUnitPrice',
  'PricingCurrencyEffectiveCost', 'PricingCurrencyListUnitPrice', 'PricingQuantity', 'PricingUnit',
  'ProviderName', 'PublisherName', 'RegionId', 'RegionName', 'ResourceId', 'ResourceName', 'ResourceType',
  'ServiceCategory', 'ServiceName', 'ServiceSubcategory', 'SkuId', 'SkuMeter', 'SkuPriceId',
  'SkuPriceDetails', 'SubAccountId', 'SubAccountName', 'SubAccountType', 'Tags', 'x_Discounts',
  'x_Operation', 'x_ServiceCode',
] as const;

/** Every column of `COST_OPTIMIZATION_RECOMMENDATIONS`, from the same source. */
export const COST_OPTIMIZATION_RECOMMENDATIONS_COLUMNS = [
  'account_id', 'action_type', 'currency_code', 'current_resource_details', 'current_resource_summary',
  'current_resource_type', 'estimated_monthly_cost_after_discount', 'estimated_monthly_cost_before_discount',
  'estimated_monthly_savings_after_discount', 'estimated_monthly_savings_before_discount',
  'estimated_savings_percentage_after_discount', 'estimated_savings_percentage_before_discount',
  'implementation_effort', 'last_refresh_timestamp', 'recommendation_id',
  'recommendation_lookback_period_in_days', 'recommendation_source', 'recommended_resource_details',
  'recommended_resource_summary', 'recommended_resource_type', 'region', 'resource_arn', 'restart_needed',
  'rollback_possible', 'tags',
] as const;

/** Lifecycle expiry per export. Each sits above that tier's default
 *  `retentionDays`: a month's files keep being rewritten until its billing
 *  finalises, so expiring exactly at retention would drop the oldest month
 *  early. Also the parameters' minimums. */
export const EXPORTS_STACK_EXPIRY_DAYS = {
  daily: { default: 400, minimum: DEFAULT_RETENTION_DAYS.daily },
  hourly: { default: 60, minimum: DEFAULT_RETENTION_DAYS.hourly },
  costOptimization: { default: 100, minimum: DEFAULT_RETENTION_DAYS.costOptimization },
} as const;

/** The S3 path to configure for each export's tier: the export's own folder,
 *  which holds its `data/` and `metadata/`. */
export function exportsStackPath(bucket: string, tier: ExportsStackTier): string {
  const { prefix, exportName } = EXPORTS_STACK_LAYOUT[tier];
  return `s3://${bucket}/${prefix}/${exportName}/`;
}

/** Answers the setup wizard bakes into the template as parameter defaults. */
export interface ExportsStackDefaults {
  /** Empty lets the stack name it `costgoblin-billing-<account id>`. */
  readonly bucketName?: string;
  readonly hourly?: boolean;
  readonly costOptimization?: boolean;
  /** Whether the stack creates the Data Exports service-linked role the Cost
   *  Optimization Hub export needs. False when the account already has it. */
  readonly serviceRole?: boolean;
}

const RESERVED_BUCKET_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'];
const RESERVED_BUCKET_SUFFIXES = ['-s3alias', '--ol-s3', '.mrap', '--x-s3', '--table-s3'];

/** S3's bucket naming rules: 3 to 63 lowercase letters, digits, dots and
 *  hyphens, starting and ending with a letter or digit, no `..`, not shaped
 *  like an IP address, and none of the prefixes and suffixes S3 reserves. */
export function isValidS3BucketName(name: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)
    && !name.includes('..')
    && !/^\d+\.\d+\.\d+\.\d+$/.test(name)
    && !RESERVED_BUCKET_PREFIXES.some(p => name.startsWith(p))
    && !RESERVED_BUCKET_SUFFIXES.some(s => name.endsWith(s));
}

const DEFAULTS_KEYS = new Set(['bucketName', 'hourly', 'costOptimization', 'serviceRole']);

/** The wizard's answers, checked: they reach the main process over IPC, and a
 *  bucket name ends up in a file the user uploads to their AWS account. */
export function parseExportsStackDefaults(payload: unknown): ExportsStackDefaults | null {
  if (!isStringRecord(payload)) return null;
  if (Object.keys(payload).some(k => !DEFAULTS_KEYS.has(k))) return null;
  const { bucketName, hourly, costOptimization, serviceRole } = payload;
  if (bucketName !== undefined && (typeof bucketName !== 'string' || !isValidS3BucketName(bucketName))) return null;
  for (const flag of [hourly, costOptimization, serviceRole]) {
    if (flag !== undefined && typeof flag !== 'boolean') return null;
  }
  return {
    ...(typeof bucketName === 'string' ? { bucketName } : {}),
    ...(typeof hourly === 'boolean' ? { hourly } : {}),
    ...(typeof costOptimization === 'boolean' ? { costOptimization } : {}),
    ...(typeof serviceRole === 'boolean' ? { serviceRole } : {}),
  };
}

const ref = (name: string): TemplateObject => ({ Ref: name });
const sub = (text: string): TemplateObject => ({ 'Fn::Sub': text });
const equals = (a: TemplateValue, b: TemplateValue): TemplateObject => ({ 'Fn::Equals': [a, b] });
const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

const P = EXPORTS_STACK_PARAMETERS;

function parameters(defaults: ExportsStackDefaults): TemplateObject {
  const expiration = (tier: ExportsStackTier, label: string): TemplateObject => ({
    Type: 'Number',
    Default: EXPORTS_STACK_EXPIRY_DAYS[tier].default,
    MinValue: EXPORTS_STACK_EXPIRY_DAYS[tier].minimum,
    Description: `Days before the ${label} export's files expire. Keep it at or above CostGoblin's retentionDays for that tier.`,
  });
  return {
    [P.bucketName]: {
      Type: 'String',
      Default: defaults.bucketName ?? '',
      AllowedPattern: '^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$',
      Description: 'Name of the new S3 bucket, globally unique. Leave empty for costgoblin-billing-<account id>.',
    },
    // The wizard always wants it; an account that already has its FOCUS 1.2
    // exports (AWS allows two) turns it off by hand.
    [P.daily]: {
      Type: 'String',
      AllowedValues: ['no', 'yes'],
      Default: 'yes',
      Description: 'Export daily FOCUS data, the data CostGoblin reads. Choose no if the account already has its FOCUS 1.2 exports (AWS allows two) and you only want the ones it lacks.',
    },
    [P.hourly]: {
      Type: 'String',
      AllowedValues: ['no', 'yes'],
      Default: yesNo(defaults.hourly ?? false),
      Description: 'Export hourly FOCUS data, for intraday drill-down. It is the large one.',
    },
    [P.costOptimization]: {
      Type: 'String',
      AllowedValues: ['no', 'yes'],
      Default: yesNo(defaults.costOptimization ?? false),
      Description: 'Export Cost Optimization Hub recommendations. Enable Cost Optimization Hub first (Billing and Cost Management > Cost Optimization Hub), or the stack fails.',
    },
    [P.serviceRole]: {
      Type: 'String',
      AllowedValues: ['no', 'yes'],
      Default: yesNo(defaults.serviceRole ?? true),
      Description: 'Only used with the Cost Optimization Hub export: create the AWSServiceRoleForBCMDataExports role it needs. Choose no if IAM > Roles already lists it: an earlier Cost Optimization Hub export, or a failed attempt of this stack, leaves it behind.',
    },
    [P.dailyExpirationDays]: expiration('daily', 'daily'),
    [P.hourlyExpirationDays]: expiration('hourly', 'hourly'),
    [P.costOptimizationExpirationDays]: expiration('costOptimization', 'Cost Optimization Hub'),
  };
}

function lifecycleRule(tier: ExportsStackTier, expirationParameter: string): TemplateObject {
  return {
    Id: EXPORTS_STACK_LAYOUT[tier].exportName,
    Status: 'Enabled',
    Prefix: `${EXPORTS_STACK_LAYOUT[tier].prefix}/`,
    ExpirationInDays: ref(expirationParameter),
    // The bucket isn't versioned; this keeps the rule right if someone turns it on.
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  };
}

function dataExport(tier: ExportsStackTier, description: string, dataQuery: TemplateObject): TemplateObject {
  const { exportName, prefix } = EXPORTS_STACK_LAYOUT[tier];
  return {
    Name: exportName,
    Description: description,
    DataQuery: dataQuery,
    DestinationConfigurations: {
      S3Destination: {
        S3Bucket: ref('Bucket'),
        S3Prefix: prefix,
        S3Region: ref('AWS::Region'),
        S3OutputConfigurations: {
          OutputType: 'CUSTOM',
          Format: 'PARQUET',
          Compression: 'PARQUET',
          // CostGoblin only reads files delivered in place (#692).
          Overwrite: 'OVERWRITE_REPORT',
        },
      },
    },
    RefreshCadence: { Frequency: 'SYNCHRONOUS' },
  };
}

function focusQuery(granularity: 'DAILY' | 'HOURLY'): TemplateObject {
  return {
    QueryStatement: `SELECT ${FOCUS_1_2_AWS_COLUMNS.join(', ')} FROM FOCUS_1_2_AWS`,
    TableConfigurations: { FOCUS_1_2_AWS: { TIME_GRANULARITY: granularity } },
  };
}

const COST_OPTIMIZATION_QUERY: TemplateObject = {
  QueryStatement: `SELECT ${COST_OPTIMIZATION_RECOMMENDATIONS_COLUMNS.join(', ')} FROM COST_OPTIMIZATION_RECOMMENDATIONS`,
  TableConfigurations: { COST_OPTIMIZATION_RECOMMENDATIONS: { INCLUDE_ALL_RECOMMENDATIONS: 'TRUE', FILTER: '{}' } },
};

function resources(): TemplateObject {
  return {
    Bucket: {
      Type: 'AWS::S3::Bucket',
      // Billing history outlives the stack: deleting it removes the exports
      // and the policies, never the data already delivered.
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        BucketName: { 'Fn::If': ['BucketNameGiven', ref(P.bucketName), sub('costgoblin-billing-${AWS::AccountId}')] },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
        },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        LifecycleConfiguration: {
          Rules: [
            lifecycleRule('daily', P.dailyExpirationDays),
            lifecycleRule('hourly', P.hourlyExpirationDays),
            lifecycleRule('costOptimization', P.costOptimizationExpirationDays),
          ],
        },
      },
    },
    BucketPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: ref('Bucket'),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              // The policy AWS documents for Data Exports delivery.
              Sid: 'EnableAWSDataExportsToWriteToS3',
              Effect: 'Allow',
              Principal: { Service: 'bcm-data-exports.amazonaws.com' },
              Action: 's3:PutObject',
              Resource: sub('${Bucket.Arn}/*'),
              Condition: {
                ArnLike: { 'aws:SourceArn': sub('arn:${AWS::Partition}:bcm-data-exports:us-east-1:${AWS::AccountId}:export/*') },
                StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') },
              },
            },
            {
              Sid: 'DenyInsecureTransport',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [sub('${Bucket.Arn}'), sub('${Bucket.Arn}/*')],
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            },
          ],
        },
      },
    },
    DailyFocusExport: {
      Type: 'AWS::BCMDataExports::Export',
      Condition: 'WantsDaily',
      DependsOn: 'BucketPolicy',
      Properties: { Export: dataExport('daily', 'Daily FOCUS 1.2 billing data for CostGoblin.', focusQuery('DAILY')) },
    },
    HourlyFocusExport: {
      Type: 'AWS::BCMDataExports::Export',
      Condition: 'WantsHourly',
      DependsOn: 'BucketPolicy',
      Properties: { Export: dataExport('hourly', 'Hourly FOCUS 1.2 billing data for CostGoblin.', focusQuery('HOURLY')) },
    },
    DataExportsServiceRole: {
      Type: 'AWS::IAM::ServiceLinkedRole',
      Condition: 'CreatesServiceRole',
      // One role per account, shared by every Cost Optimization Hub export in
      // it: deleting the stack must not take it from exports made elsewhere.
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: { AWSServiceName: 'bcm-data-exports.amazonaws.com' },
    },
    CostOptimizationExport: {
      Type: 'AWS::BCMDataExports::Export',
      Condition: 'WantsCostOptimization',
      DependsOn: 'BucketPolicy',
      // Waits for the service-linked role when the stack creates it. DependsOn
      // can't name a resource whose condition may be false; a conditional Ref
      // can, and it orders creation the same way.
      Metadata: { ServiceRole: { 'Fn::If': ['CreatesServiceRole', ref('DataExportsServiceRole'), ref('AWS::NoValue')] } },
      Properties: {
        Export: dataExport('costOptimization', 'Cost Optimization Hub recommendations for CostGoblin.', COST_OPTIMIZATION_QUERY),
      },
    },
    ReadAccessPolicy: {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        Description: 'Read-only access CostGoblin needs to the billing exports bucket.',
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: 's3:ListBucket', Resource: sub('${Bucket.Arn}') },
            { Effect: 'Allow', Action: 's3:GetObject', Resource: sub('${Bucket.Arn}/*') },
          ],
        },
      },
    },
  };
}

function outputs(): TemplateObject {
  const path = (tier: ExportsStackTier): TemplateObject =>
    sub(`s3://\${Bucket}/${EXPORTS_STACK_LAYOUT[tier].prefix}/${EXPORTS_STACK_LAYOUT[tier].exportName}/`);
  return {
    BucketName: { Description: 'The bucket the exports deliver to.', Value: ref('Bucket') },
    DailyExportPath: { Condition: 'WantsDaily', Description: "CostGoblin's daily data path.", Value: path('daily') },
    HourlyExportPath: { Condition: 'WantsHourly', Description: "CostGoblin's hourly data path.", Value: path('hourly') },
    CostOptimizationExportPath: {
      Condition: 'WantsCostOptimization', Description: "CostGoblin's cost optimization data path.", Value: path('costOptimization'),
    },
    ReadAccessPolicyArn: {
      Description: 'Attach to the role or user CostGoblin reads with.', Value: ref('ReadAccessPolicy'),
    },
  };
}

/** The stack's template, with the wizard's answers as parameter defaults. */
export function buildExportsStackTemplate(defaults: ExportsStackDefaults = {}): TemplateObject {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'CostGoblin billing exports: an S3 bucket with lifecycle rules, AWS Data Exports for FOCUS 1.2 '
      + '(daily and hourly) and Cost Optimization Hub, each optional, and a read-only policy for CostGoblin.',
    Metadata: {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          { Label: { default: 'Bucket' }, Parameters: [P.bucketName] },
          { Label: { default: 'Exports' }, Parameters: [P.daily, P.hourly, P.costOptimization, P.serviceRole] },
          { Label: { default: 'Lifecycle' }, Parameters: [P.dailyExpirationDays, P.hourlyExpirationDays, P.costOptimizationExpirationDays] },
        ],
      },
    },
    Parameters: parameters(defaults),
    Rules: {
      RunsInUsEast1: {
        Assertions: [{
          Assert: equals(ref('AWS::Region'), 'us-east-1'),
          AssertDescription: 'AWS Data Exports can only be created in us-east-1. Switch the console to US East (N. Virginia).',
        }],
      },
      CreatesAnExport: {
        Assertions: [{
          Assert: { 'Fn::Or': [equals(ref(P.daily), 'yes'), equals(ref(P.hourly), 'yes'), equals(ref(P.costOptimization), 'yes')] },
          AssertDescription: 'Choose at least one export to create.',
        }],
      },
    },
    Conditions: {
      BucketNameGiven: { 'Fn::Not': [equals(ref(P.bucketName), '')] },
      WantsDaily: equals(ref(P.daily), 'yes'),
      WantsHourly: equals(ref(P.hourly), 'yes'),
      WantsCostOptimization: equals(ref(P.costOptimization), 'yes'),
      CreatesServiceRole: { 'Fn::And': [{ Condition: 'WantsCostOptimization' }, equals(ref(P.serviceRole), 'yes')] },
    },
    Resources: resources(),
    Outputs: outputs(),
  };
}
