import { asDollars } from '../types/branded.js';
import type {
  CommitmentDetails,
  CommitmentPaymentOption,
  CommitmentTerm,
  CommitmentUsageScope,
  ImplementationEffort,
  ResourceUsage,
  SavingsRecommendation,
} from '../types/query.js';
import { isStringRecord, parseJsonObject } from '../utils/json.js';

// One row of the Savings query (Cost Optimization Hub export columns, aliased
// by `buildSavingsQuery`) → a SavingsRecommendation. The details columns are
// free-form JSON written by AWS — `{ <resourceType>: { configuration,
// costCalculation } }` — so every read below degrades to "unknown" instead of
// throwing. No Node imports: the Savings view counts in the renderer too.

type Row = Readonly<Record<string, unknown>>;
type JsonObject = Readonly<Record<string, unknown>>;

const COMMITMENT_ACTIONS: ReadonlySet<string> = new Set(['PurchaseSavingsPlans', 'PurchaseReservedInstances']);

/** Resource types whose spend a Compute Savings Plan covers. */
const COMPUTE_SP_RESOURCES: readonly string[] = ['Ec2Instance', 'Ec2AutoScalingGroup', 'EcsService', 'LambdaFunction'];
const EC2_RESOURCES: readonly string[] = ['Ec2Instance', 'Ec2AutoScalingGroup'];
const RDS_RESOURCES: readonly string[] = ['RdsDbInstance'];

/** The resource types the other commitments cover, where COH has resource
 *  actions for them. A type missing here is never shrunk by resource actions. */
const OTHER_COMMITMENT_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  ElastiCacheReservedInstances: ['ElastiCacheCluster'],
  MemoryDbReservedInstances: ['MemoryDbCluster'],
  SageMakerSavingsPlans: ['SageMakerEndpoint'],
};

const COMMITMENT_LABELS: Readonly<Record<string, string>> = {
  ElastiCacheReservedInstances: 'ElastiCache Reserved Instances',
  OpenSearchReservedInstances: 'OpenSearch Reserved Instances',
  RedshiftReservedInstances: 'Redshift Reserved Instances',
  MemoryDbReservedInstances: 'MemoryDB Reserved Instances',
  DynamoDbReservedCapacity: 'DynamoDB Reserved Capacity',
  SageMakerSavingsPlans: 'SageMaker Savings Plans',
};

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

/** A number AWS may write as a JSON number or a numeric string (`"38.0"`). */
function amount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function record(v: unknown): JsonObject | null {
  return isStringRecord(v) ? v : null;
}

function effort(v: string): ImplementationEffort {
  switch (v) {
    case 'VeryLow':
    case 'Low':
    case 'Medium':
    case 'High':
      return v;
    default:
      return 'Medium';
  }
}

function term(v: unknown): CommitmentTerm | null {
  return v === 'OneYear' || v === 'ThreeYears' ? v : null;
}

function paymentOption(v: unknown): CommitmentPaymentOption | null {
  return v === 'NoUpfront' || v === 'PartialUpfront' || v === 'AllUpfront' ? v : null;
}

/** The single resource entry of a details column, or null. */
function detailsEntry(json: string): JsonObject | null {
  if (json.length === 0) return null;
  const parsed = parseJsonObject(json);
  if (parsed === null) return null;
  return record(Object.values(parsed)[0]);
}

/** `t2.large` → `t2`, `db.t3.small` → `db.t3`, `cache.r6g.large` → `cache.r6g`. */
export function instanceFamily(instanceType: string): string | null {
  const dot = instanceType.lastIndexOf('.');
  return dot > 0 ? instanceType.slice(0, dot) : null;
}

function familyOf(entry: JsonObject | null): string | null {
  const instance = record(record(entry?.['configuration'])?.['instance']);
  const type = instance?.['type'] ?? instance?.['dbInstanceClass'];
  return typeof type === 'string' ? instanceFamily(type) : null;
}

/** RDS bills Multi-AZ and Single-AZ hours under different usage types; the
 *  summary (`db.t3.small/Single AZ Deployment`) says it too. */
function rdsDeployment(entry: JsonObject | null, currentSummary: string): string | null {
  const usages = record(entry?.['costCalculation'])?.['usages'];
  if (Array.isArray(usages)) {
    for (const usage of usages) {
      const usageType = record(usage)?.['usageType'];
      if (typeof usageType !== 'string') continue;
      if (usageType.includes('Multi-AZ')) return 'Multi-AZ';
      if (usageType.includes('InstanceUsage')) return 'Single-AZ';
    }
  }
  if (/multi[- ]az/i.test(currentSummary)) return 'Multi-AZ';
  if (/single[- ]az/i.test(currentSummary)) return 'Single-AZ';
  return null;
}

function resourceUsage(resourceType: string, current: JsonObject | null, recommended: JsonObject | null, currentSummary: string): ResourceUsage {
  return {
    family: familyOf(current),
    targetFamily: familyOf(recommended),
    deployment: RDS_RESOURCES.includes(resourceType) ? rdsDeployment(current, currentSummary) : null,
  };
}

/** Distinct parts joined for a label; empty parts are left out. */
function label(...parts: readonly string[]): string {
  return parts.filter(p => p.length > 0).join(' · ');
}

function humanizeType(resourceType: string): string {
  return COMMITMENT_LABELS[resourceType] ?? resourceType.replaceAll(/([a-z])([A-Z])/g, '$1 $2');
}

interface CoverageInput {
  readonly resourceType: string;
  readonly providerName: string;
  readonly accountId: string;
  readonly region: string;
  readonly config: JsonObject | null;
}

interface CoverageContext extends CoverageInput {
  readonly linked: boolean;
}

type Coverage = Pick<CommitmentDetails, 'pool' | 'coveredBy' | 'poolLabel' | 'scope'>;

/** A pool key: the commitment type and the usage it covers. A payer-level
 *  commitment covers every account of its export, so its key names no
 *  account. Keys include the provider: each provider is one export, i.e. one
 *  payer. */
function poolKey(ctx: CoverageContext, linked: boolean, type: string, shape: readonly string[]): string {
  return JSON.stringify([type, ctx.providerName, linked ? 'Linked' : 'Payer', linked ? ctx.accountId : '', ...shape]);
}

/** The pools of `type` and `shape` that cover this commitment's usage: the
 *  payer's, and for a linked-account commitment its own account's too. */
function coveringPools(ctx: CoverageContext, type: string, shape: readonly string[]): string[] {
  return ctx.linked ? [poolKey(ctx, false, type, shape), poolKey(ctx, true, type, shape)] : [poolKey(ctx, false, type, shape)];
}

/** A linked-account pool is covered by the payer pool of the same shape. */
function payerTwin(ctx: CoverageContext, type: string, shape: readonly string[]): string[] {
  return ctx.linked ? [poolKey(ctx, false, type, shape)] : [];
}

function usageScope(ctx: CoverageContext, resourceTypes: readonly string[], fields: Partial<CommitmentUsageScope> = {}): CommitmentUsageScope {
  return {
    providerName: ctx.providerName,
    resourceTypes,
    accountId: ctx.linked ? ctx.accountId : null,
    region: null,
    family: null,
    deployment: null,
    ...fields,
  };
}

function accountLabel(ctx: CoverageContext): string {
  return ctx.linked ? `account ${ctx.accountId}` : '';
}

function configString(ctx: CoverageContext, key: string): string {
  return str(ctx.config?.[key]);
}

/** Instance family, and the instance size a reservation that is not size
 *  flexible is bound to (empty when it is). */
function familyAndSize(ctx: CoverageContext): { readonly family: string; readonly size: string } {
  const instanceType = configString(ctx, 'instanceType');
  const flexible = ctx.config?.['sizeFlexEligible'] === true || ctx.config?.['sizeFlexEligible'] === 'true';
  return {
    family: configString(ctx, 'instanceFamily') || (instanceFamily(instanceType) ?? ''),
    size: flexible ? '' : instanceType,
  };
}

function reservationRegion(ctx: CoverageContext): string {
  return configString(ctx, 'reservedInstancesRegion') || ctx.region;
}

function computeSavingsPlanCoverage(ctx: CoverageContext): Coverage {
  return {
    pool: poolKey(ctx, ctx.linked, 'ComputeSavingsPlans', []),
    coveredBy: payerTwin(ctx, 'ComputeSavingsPlans', []),
    poolLabel: label('Compute Savings Plans', accountLabel(ctx)),
    scope: usageScope(ctx, COMPUTE_SP_RESOURCES),
  };
}

/** EC2 Instance Savings Plans and EC2 RIs: a Compute Savings Plan covers
 *  both, and an EC2 Instance Savings Plan covers the RIs of its family and
 *  region. */
function ec2Coverage(ctx: CoverageContext): Coverage {
  const { family, size } = familyAndSize(ctx);
  const instancePlan = ctx.resourceType === 'Ec2InstanceSavingsPlans';
  const region = instancePlan ? configString(ctx, 'savingsPlansRegion') || ctx.region : reservationRegion(ctx);
  const planShape = [region, family];
  const scope = usageScope(ctx, EC2_RESOURCES, { region, family: family || null });
  const computePools = coveringPools(ctx, 'ComputeSavingsPlans', []);
  if (instancePlan) {
    return {
      pool: poolKey(ctx, ctx.linked, 'Ec2InstanceSavingsPlans', planShape),
      coveredBy: [...computePools, ...payerTwin(ctx, 'Ec2InstanceSavingsPlans', planShape)],
      poolLabel: label('EC2 Instance Savings Plans', family, region, accountLabel(ctx)),
      scope,
    };
  }
  const platform = configString(ctx, 'platform');
  const tenancy = configString(ctx, 'tenancy');
  const riShape = [region, family, size, platform, tenancy];
  return {
    pool: poolKey(ctx, ctx.linked, 'Ec2ReservedInstances', riShape),
    coveredBy: [...computePools, ...coveringPools(ctx, 'Ec2InstanceSavingsPlans', planShape), ...payerTwin(ctx, 'Ec2ReservedInstances', riShape)],
    poolLabel: label('EC2 Reserved Instances', size || family, region, platform, tenancy === 'Shared' ? '' : tenancy, accountLabel(ctx)),
    scope,
  };
}

function rdsCoverage(ctx: CoverageContext): Coverage {
  const { family, size } = familyAndSize(ctx);
  const region = reservationRegion(ctx);
  const engine = [configString(ctx, 'databaseEngine'), configString(ctx, 'databaseEdition')].filter(p => p.length > 0).join(' ');
  const deployment = configString(ctx, 'deploymentOption');
  const shape = [region, family, size, engine, configString(ctx, 'licenseModel'), deployment];
  return {
    pool: poolKey(ctx, ctx.linked, 'RdsReservedInstances', shape),
    coveredBy: payerTwin(ctx, 'RdsReservedInstances', shape),
    poolLabel: label('RDS Reserved Instances', size || family, region, engine, deployment, accountLabel(ctx)),
    scope: usageScope(ctx, RDS_RESOURCES, { region, family: family || null, deployment: deployment || null }),
  };
}

/** Other reservations, reserved capacity and the SageMaker Savings Plan:
 *  pooled on what their configuration says they cover. */
function otherCoverage(ctx: CoverageContext): Coverage {
  const { family, size } = familyAndSize(ctx);
  const region = ctx.resourceType.endsWith('SavingsPlans') ? '' : reservationRegion(ctx);
  const shape = [region, family, size];
  return {
    pool: poolKey(ctx, ctx.linked, ctx.resourceType, shape),
    coveredBy: payerTwin(ctx, ctx.resourceType, shape),
    poolLabel: label(humanizeType(ctx.resourceType), size || family, region, accountLabel(ctx)),
    scope: usageScope(ctx, OTHER_COMMITMENT_RESOURCES[ctx.resourceType] ?? [], { region: region || null, family: family || null }),
  };
}

/** Which usage a commitment covers: its pool and the broader pools over it. */
function coverage(input: CoverageInput): Coverage {
  const ctx: CoverageContext = { ...input, linked: input.config?.['accountScope'] === 'Linked' };
  switch (input.resourceType) {
    case 'ComputeSavingsPlans':
      return computeSavingsPlanCoverage(ctx);
    case 'Ec2InstanceSavingsPlans':
    case 'Ec2ReservedInstances':
      return ec2Coverage(ctx);
    case 'RdsReservedInstances':
      return rdsCoverage(ctx);
    default:
      return otherCoverage(ctx);
  }
}

function commitmentDetails(input: CoverageInput & { readonly entry: JsonObject | null; readonly monthlyCost: number }): CommitmentDetails {
  const { entry, config, monthlyCost } = input;
  const pricing = record(record(entry?.['costCalculation'])?.['pricing']);
  const eligible = amount(pricing?.['monthlySavingsPlansEligibleCost']) ?? amount(pricing?.['monthlyReservationEligibleCost']) ?? monthlyCost;
  const upfrontCost = amount(config?.['upfrontCost']);
  return {
    term: term(config?.['term']),
    paymentOption: paymentOption(config?.['paymentOption']),
    offeringClass: str(config?.['offeringClass']),
    upfrontCost: upfrontCost === null ? null : asDollars(upfrontCost),
    eligibleMonthlyCost: asDollars(eligible),
    ...coverage(input),
  };
}

/** One row of `buildSavingsQuery` as a SavingsRecommendation of `providerName`'s export. */
export function parseSavingsRow(row: Row, providerName: string): SavingsRecommendation {
  const actionType = str(row['action_type']);
  const resourceType = str(row['current_resource_type']);
  const accountId = str(row['account_id']);
  const region = str(row['region']);
  const currentDetails = str(row['current_details']);
  const recommendedDetails = str(row['recommended_details']);
  const currentSummary = str(row['current_summary']);
  const monthlyCost = num(row['monthly_cost']);
  const current = detailsEntry(currentDetails);
  const recommended = detailsEntry(recommendedDetails);

  const base = {
    recommendationId: str(row['recommendation_id']),
    providerName,
    accountId,
    accountName: str(row['account_name']),
    actionType,
    resourceType,
    summary: str(row['summary']),
    region,
    monthlySavings: asDollars(num(row['monthly_savings'])),
    monthlyCost: asDollars(monthlyCost),
    savingsPercentage: num(row['savings_pct']),
    effort: effort(str(row['effort'])),
    resourceArn: str(row['resource_arn']),
    currentDetails,
    recommendedDetails,
    currentSummary,
    restartNeeded: row['restart_needed'] === true,
    rollbackPossible: row['rollback_possible'] === true,
    recommendationSource: str(row['recommendation_source']),
  };

  if (COMMITMENT_ACTIONS.has(actionType)) {
    // A purchase's configuration sits in the recommended column.
    const entry = recommended ?? current;
    const config = record(entry?.['configuration']);
    return {
      ...base,
      commitment: commitmentDetails({ resourceType, providerName, accountId, region, config, entry, monthlyCost }),
      usage: null,
    };
  }
  return { ...base, commitment: null, usage: resourceUsage(resourceType, current, recommended, currentSummary) };
}
