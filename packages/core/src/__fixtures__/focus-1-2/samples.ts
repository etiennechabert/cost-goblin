/** Deterministic generator for the committed FOCUS 1.2 provider samples.
 *
 *  One billing month (2026-05) is modelled once as provider-neutral billing
 *  events, then rendered three times through each provider's native column
 *  set and value conventions. Same events, same costs — so a difference
 *  between `samples/aws.csv`, `samples/azure.csv` and `samples/gcp.csv` is
 *  always a real difference in how that provider bills or shapes its export,
 *  never generator noise.
 *
 *  The row populations are the ones that break naive cost tooling:
 *  commitment-covered usage priced below its billed cost, an unused
 *  commitment carrying only effective cost, a month-span purchase, tax,
 *  a negative credit, and a marketplace/third-party row whose service
 *  attribution comes from the publisher rather than the provider.
 *
 *  Regenerate with:
 *    npx tsx packages/core/src/__fixtures__/focus-1-2/write-samples.ts */

import { seededRandom } from '../focus-fixture.js';
import type { Rand } from '../focus-fixture.js';
import { NATIVE_COLUMNS } from './shapes.js';
import type { SampleProvider } from './shapes.js';

/** The single billing month every sample covers. */
export const SAMPLE_MONTH = '2026-05';
/** Usage rows span the first fortnight; month-span charges cover all of May. */
const USAGE_DAYS = 14;
const MONTH_START = `${SAMPLE_MONTH}-01 00:00:00`;
const MONTH_END = '2026-06-01 00:00:00';

/** Rows emitted per provider: 14 days × (6 usage + 1 committed + 1
 *  marketplace) + 4 month-span charges. */
export const SAMPLE_ROW_COUNT = USAGE_DAYS * 8 + 4;

type EventKind =
  | 'usage'
  | 'committed-usage'
  | 'unused-commitment'
  | 'purchase'
  | 'tax'
  | 'credit'
  | 'marketplace';

/** A billing event, provider-neutral: what happened, to which account, for
 *  how much. Provider vocabulary (service naming, resource-id syntax, tag
 *  key casing) is applied when the event is rendered. */
interface BillingEvent {
  readonly kind: EventKind;
  readonly chargeStart: string;
  readonly chargeEnd: string;
  readonly accountIdx: number;
  readonly regionIdx: number;
  readonly serviceIdx: number;
  readonly resourceSeq: number;
  readonly quantity: number;
  readonly billed: number;
  readonly effective: number;
  readonly list: number;
  readonly contracted: number;
  readonly tags: Readonly<Record<string, string>>;
}

interface SampleService {
  readonly name: string;
  readonly category: string;
  readonly subcategory: string;
  /** Provider's own service identifier: AWS `x_ServiceCode`, GCP
   *  `x_ServiceId`, Azure's meter service family. */
  readonly code: string;
  readonly operation: string;
  readonly skuMeter: string;
  readonly skuId: string;
  readonly unit: string;
  readonly resourceKind: string;
  /** The namespace a resource identifier is built from — an ARN service
   *  namespace on AWS, an ARM resource provider on Azure, an API host on
   *  GCP. Each provider's resource-id syntax is different enough that
   *  tooling which pattern-matches on it has to be tested per provider. */
  readonly namespace: string;
}

interface SampleAccount {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

interface SampleRegion {
  readonly id: string;
  readonly name: string;
}

interface SampleVocabulary {
  readonly providerName: string;
  readonly publisherName: string;
  readonly invoiceIssuerName: string;
  readonly currency: string;
  readonly billingAccountId: string;
  readonly billingAccountName: string;
  readonly billingAccountType: string;
  readonly accounts: readonly SampleAccount[];
  readonly regions: readonly SampleRegion[];
  readonly services: readonly SampleService[];
  readonly marketplacePublisher: string;
  readonly marketplaceService: SampleService;
  readonly commitmentId: string;
  readonly commitmentName: string;
  readonly commitmentType: string;
  readonly commitmentCategory: string;
  readonly commitmentUnit: string;
  /** Tag keys, in this provider's own casing convention. */
  readonly tagKeys: { readonly team: string; readonly system: string; readonly environment: string };
  resourceId(service: SampleService, region: SampleRegion, account: SampleAccount, seq: number): string;
  resourceName(service: SampleService, seq: number): string;
}

function at<T>(arr: readonly T[], idx: number): T {
  const item = arr[idx % arr.length];
  if (item === undefined) throw new Error('sample vocabulary is empty');
  return item;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function unitPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const TEAMS = ['platform', 'payments', 'data-eng', 'security'];
const SYSTEMS = ['api-gateway', 'ledger', 'event-bus', 'risk-engine'];
const ENVS = ['production', 'staging', 'sandbox'];

function eventTags(rand: Rand): Readonly<Record<string, string>> {
  // ~8% of usage rows are untagged — the population every tag-coverage
  // report has to account for.
  if (rand() < 0.08) return {};
  return {
    team: at(TEAMS, Math.floor(rand() * TEAMS.length)),
    system: at(SYSTEMS, Math.floor(rand() * SYSTEMS.length)),
    environment: at(ENVS, Math.floor(rand() * ENVS.length)),
  };
}

/** The month's billing events. Seeded, so the committed CSVs are
 *  byte-reproducible; identical across providers by construction. */
function billingEvents(): readonly BillingEvent[] {
  const rand = seededRandom(1202);
  const events: BillingEvent[] = [];

  for (let day = 1; day <= USAGE_DAYS; day++) {
    const date = `${SAMPLE_MONTH}-${String(day).padStart(2, '0')}`;
    const next = `${SAMPLE_MONTH}-${String(day + 1).padStart(2, '0')}`;
    const start = `${date} 00:00:00`;
    const end = `${next} 00:00:00`;

    for (let i = 0; i < 6; i++) {
      const list = money(4 + rand() * 180);
      const contracted = money(list * (0.72 + rand() * 0.2));
      events.push({
        kind: 'usage',
        chargeStart: start, chargeEnd: end,
        accountIdx: Math.floor(rand() * 4),
        regionIdx: Math.floor(rand() * 5),
        serviceIdx: Math.floor(rand() * 6),
        resourceSeq: 100 + Math.floor(rand() * 400),
        quantity: money(rand() * 720),
        billed: contracted, effective: contracted, list, contracted,
        tags: eventTags(rand),
      });
    }

    // Commitment-covered usage: the invoice charge sits on the Purchase row,
    // so BilledCost is 0 while EffectiveCost carries the amortized share.
    const coveredList = money(20 + rand() * 60);
    const coveredEffective = money(coveredList * 0.62);
    events.push({
      kind: 'committed-usage',
      chargeStart: start, chargeEnd: end,
      accountIdx: Math.floor(rand() * 4),
      regionIdx: 0,
      serviceIdx: 0,
      resourceSeq: 900 + Math.floor(rand() * 20),
      quantity: money(12 + rand() * 12),
      billed: 0, effective: coveredEffective, list: coveredList, contracted: coveredEffective,
      tags: eventTags(rand),
    });

    // Third-party / marketplace consumption billed through the provider.
    const mktCost = money(1 + rand() * 40);
    events.push({
      kind: 'marketplace',
      chargeStart: start, chargeEnd: end,
      accountIdx: Math.floor(rand() * 4),
      regionIdx: Math.floor(rand() * 5),
      serviceIdx: 0,
      resourceSeq: 500 + Math.floor(rand() * 50),
      quantity: money(rand() * 900_000),
      billed: mktCost, effective: mktCost, list: 0, contracted: mktCost,
      tags: eventTags(rand),
    });
  }

  const monthSpan = { chargeStart: MONTH_START, chargeEnd: MONTH_END };
  events.push({
    kind: 'unused-commitment', ...monthSpan,
    accountIdx: 0, regionIdx: 0, serviceIdx: 0, resourceSeq: 1,
    quantity: 0, billed: 0, effective: 84.5, list: 0, contracted: 0, tags: {},
  });
  events.push({
    kind: 'purchase', ...monthSpan,
    accountIdx: 0, regionIdx: 0, serviceIdx: 0, resourceSeq: 1,
    quantity: 0, billed: 1460.0, effective: 0, list: 0, contracted: 1460.0, tags: {},
  });
  events.push({
    kind: 'tax', ...monthSpan,
    accountIdx: 0, regionIdx: 0, serviceIdx: 0, resourceSeq: 0,
    quantity: 0, billed: 372.15, effective: 372.15, list: 0, contracted: 372.15, tags: {},
  });
  events.push({
    kind: 'credit', ...monthSpan,
    accountIdx: 0, regionIdx: 0, serviceIdx: 0, resourceSeq: 0,
    quantity: 0, billed: -215.4, effective: -215.4, list: 0, contracted: -215.4, tags: {},
  });

  return events;
}

const AWS: SampleVocabulary = {
  providerName: 'AWS',
  publisherName: 'Amazon Web Services, Inc.',
  invoiceIssuerName: 'Amazon Web Services EMEA SARL',
  currency: 'USD',
  billingAccountId: '100000000000',
  billingAccountName: 'Acme Corp Payer',
  billingAccountType: 'BillingAccount',
  accounts: [
    { id: '111111111111', name: 'Acme Platform Production', type: 'Account' },
    { id: '222222222222', name: 'Acme Payments Production', type: 'Account' },
    { id: '333333333333', name: 'Acme Data Analytics', type: 'Account' },
    { id: '444444444444', name: 'Acme Development Sandbox', type: 'Account' },
  ],
  regions: [
    { id: 'us-east-1', name: 'US East (N. Virginia)' },
    { id: 'eu-west-1', name: 'Europe (Ireland)' },
    { id: 'eu-central-1', name: 'Europe (Frankfurt)' },
    { id: 'us-west-2', name: 'US West (Oregon)' },
    { id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
  ],
  services: [
    { name: 'Amazon Elastic Compute Cloud', category: 'Compute', subcategory: 'Virtual Machines', code: 'AmazonEC2', operation: 'RunInstances', skuMeter: 'BoxUsage:m5.large', skuId: 'HZC9FAP4F9Y8JW67', unit: 'Hrs', resourceKind: 'instance', namespace: 'ec2' },
    { name: 'Amazon Relational Database Service', category: 'Databases', subcategory: 'Relational Databases', code: 'AmazonRDS', operation: 'CreateDBInstance:0002', skuMeter: 'InstanceUsage:db.r5.large', skuId: 'V9J2XQ4YRB6PS3TM', unit: 'Hrs', resourceKind: 'db', namespace: 'rds' },
    { name: 'Amazon Simple Storage Service', category: 'Storage', subcategory: 'Object Storage', code: 'AmazonS3', operation: 'PutObject', skuMeter: 'TimedStorage-ByteHrs', skuId: 'WMYPY7NCFQZK5D8H', unit: 'GB-Mo', resourceKind: 'bucket', namespace: 's3' },
    { name: 'AWS Lambda', category: 'Compute', subcategory: 'Serverless Compute', code: 'AWSLambda', operation: 'Invoke', skuMeter: 'Lambda-GB-Second', skuId: 'QKR2N6MTXH8VD4FC', unit: 'seconds', resourceKind: 'function', namespace: 'lambda' },
    { name: 'AmazonCloudWatch', category: 'Management and Governance', subcategory: 'Observability', code: 'AmazonCloudWatch', operation: 'PutLogEvents', skuMeter: 'DataProcessing-Bytes', skuId: 'B3TDFXKP9WNC7SLM', unit: 'GB', resourceKind: 'log-group', namespace: 'logs' },
    { name: 'Amazon DynamoDB', category: 'Databases', subcategory: 'NoSQL Databases', code: 'AmazonDynamoDB', operation: 'PutItem', skuMeter: 'WriteRequestUnits', skuId: 'F5NQ8ZJVCT2XR6WD', unit: 'WriteRequestUnits', resourceKind: 'table', namespace: 'dynamodb' },
  ],
  marketplacePublisher: 'Anthropic',
  // A real AWS Marketplace row carries no service code and an empty
  // ServiceName — attribution has to come from the publisher.
  marketplaceService: { name: '', category: 'AI and Machine Learning', subcategory: 'Generative AI', code: '', operation: 'InvokeModelInference', skuMeter: '', skuId: '', unit: 'tokens', resourceKind: 'model', namespace: 'aws-marketplace' },
  commitmentId: 'arn:aws:savingsplans::100000000000:savingsplan/sp-0a1b2c3d4e5f6a7b8',
  commitmentName: 'compute-sp-3yr-noupfront',
  commitmentType: 'Savings Plan',
  commitmentCategory: 'Spend',
  commitmentUnit: 'USD/hour',
  tagKeys: { team: 'team', system: 'system', environment: 'environment' },
  resourceId: (service, region, account, seq) =>
    `arn:aws:${service.namespace}:${region.id}:${account.id}:${service.resourceKind}/${service.resourceKind}-${String(seq).padStart(4, '0')}`,
  resourceName: (service, seq) => `${service.resourceKind}-${String(seq).padStart(4, '0')}`,
};

const AZURE: SampleVocabulary = {
  providerName: 'Microsoft',
  publisherName: 'Microsoft',
  invoiceIssuerName: 'Microsoft',
  currency: 'EUR',
  billingAccountId: '8611537',
  billingAccountName: 'Acme Corp MCA',
  billingAccountType: 'BillingAccount',
  accounts: [
    { id: '3f1e7c20-0001-4a5b-9c3d-8e2f10a4b6c1', name: 'Platform Production', type: 'Subscription' },
    { id: '3f1e7c20-0002-4a5b-9c3d-8e2f10a4b6c2', name: 'Payments Production', type: 'Subscription' },
    { id: '3f1e7c20-0003-4a5b-9c3d-8e2f10a4b6c3', name: 'Data Analytics', type: 'Subscription' },
    { id: '3f1e7c20-0004-4a5b-9c3d-8e2f10a4b6c4', name: 'Development Sandbox', type: 'Subscription' },
  ],
  regions: [
    { id: 'eastus', name: 'East US' },
    { id: 'westeurope', name: 'West Europe' },
    { id: 'northeurope', name: 'North Europe' },
    { id: 'westus2', name: 'West US 2' },
    { id: 'southeastasia', name: 'Southeast Asia' },
  ],
  services: [
    { name: 'Virtual Machines', category: 'Compute', subcategory: 'Virtual Machines', code: 'Compute', operation: 'Microsoft.Compute/virtualMachines', skuMeter: 'D4s v5 Compute Hours', skuId: 'DZH318Z0BQ4P', unit: 'Hours', resourceKind: 'virtualMachines', namespace: 'Microsoft.Compute' },
    { name: 'Azure SQL Database', category: 'Databases', subcategory: 'Relational Databases', code: 'Databases', operation: 'Microsoft.Sql/servers/databases', skuMeter: 'vCore General Purpose', skuId: 'DZH318Z0BPZ2', unit: 'Hours', resourceKind: 'databases', namespace: 'Microsoft.Sql' },
    { name: 'Azure Blob Storage', category: 'Storage', subcategory: 'Object Storage', code: 'Storage', operation: 'Microsoft.Storage/storageAccounts', skuMeter: 'Hot LRS Data Stored', skuId: 'DZH318Z0BNZ4', unit: 'GB/Month', resourceKind: 'storageAccounts', namespace: 'Microsoft.Storage' },
    { name: 'Azure Functions', category: 'Compute', subcategory: 'Serverless Compute', code: 'Compute', operation: 'Microsoft.Web/sites', skuMeter: 'Execution Time', skuId: 'DZH318Z0BQ6R', unit: 'GB Seconds', resourceKind: 'sites', namespace: 'Microsoft.Web' },
    { name: 'Azure Monitor', category: 'Management and Governance', subcategory: 'Observability', code: 'Management and Governance', operation: 'Microsoft.OperationalInsights/workspaces', skuMeter: 'Data Ingestion', skuId: 'DZH318Z0BS3Q', unit: 'GB', resourceKind: 'workspaces', namespace: 'Microsoft.OperationalInsights' },
    { name: 'Azure Cosmos DB', category: 'Databases', subcategory: 'NoSQL Databases', code: 'Databases', operation: 'Microsoft.DocumentDB/databaseAccounts', skuMeter: 'RU/s Provisioned Throughput', skuId: 'DZH318Z0BPZ7', unit: '100 RU/s Hours', resourceKind: 'databaseAccounts', namespace: 'Microsoft.DocumentDB' },
  ],
  marketplacePublisher: 'Datadog',
  marketplaceService: { name: 'Datadog Pro', category: 'Management and Governance', subcategory: 'Observability', code: 'Management and Governance', operation: 'Datadog.Monitor/monitors', skuMeter: 'Pro Host Hours', skuId: 'DZH318Z0C1WY', unit: 'Hours', resourceKind: 'monitors', namespace: 'Datadog.Monitor' },
  commitmentId: '/providers/Microsoft.Capacity/reservationOrders/9d4a6c31-77b2-4f0e-9c1a-6b8e2d5f3a10/reservations/4c7f1b8e-2a93-4d6c-8e05-1f7b9a3c6d24',
  commitmentName: 'ri-d4sv5-westeurope-3yr',
  commitmentType: 'Reservation',
  commitmentCategory: 'Usage',
  commitmentUnit: 'Hours',
  // Azure tag keys preserve the casing the user typed — commonly PascalCase.
  tagKeys: { team: 'Team', system: 'System', environment: 'Environment' },
  // Azure resource IDs are lowercased in Cost Management exports, even
  // though the ARM resource itself preserves casing.
  resourceId: (service, _region, account, seq) =>
    `/subscriptions/${account.id}/resourcegroups/rg-acme-${service.resourceKind.toLowerCase()}/providers/${service.namespace.toLowerCase()}/${service.resourceKind.toLowerCase()}/${service.resourceKind.toLowerCase()}-${String(seq).padStart(4, '0')}`,
  resourceName: (service, seq) => `${service.resourceKind.toLowerCase()}-${String(seq).padStart(4, '0')}`,
};

const GCP: SampleVocabulary = {
  providerName: 'Google Cloud',
  publisherName: 'Google Cloud',
  // GCP's export has no InvoiceIssuerName column at all — this value is
  // never rendered, it only keeps the vocabulary shape uniform.
  invoiceIssuerName: 'Google Cloud',
  currency: 'USD',
  billingAccountId: '01ABCD-234567-89EFGH',
  billingAccountName: 'Acme Corp Billing',
  billingAccountType: 'BillingAccount',
  accounts: [
    { id: 'acme-platform-prod', name: 'Acme Platform Production', type: 'Project' },
    { id: 'acme-payments-prod', name: 'Acme Payments Production', type: 'Project' },
    { id: 'acme-data-prod', name: 'Acme Data Analytics', type: 'Project' },
    { id: 'acme-sandbox', name: 'Acme Development Sandbox', type: 'Project' },
  ],
  regions: [
    { id: 'us-central1', name: 'Iowa' },
    { id: 'europe-west1', name: 'Belgium' },
    { id: 'europe-west4', name: 'Netherlands' },
    { id: 'us-east4', name: 'Northern Virginia' },
    { id: 'asia-southeast1', name: 'Singapore' },
  ],
  services: [
    { name: 'Compute Engine', category: 'Compute', subcategory: 'Virtual Machines', code: '6F81-5844-456A', operation: 'compute.instances.running', skuMeter: 'N2 Instance Core running', skuId: '2E27-4F75-95CD', unit: 'hour', resourceKind: 'instances', namespace: 'compute.googleapis.com' },
    { name: 'Cloud SQL', category: 'Databases', subcategory: 'Relational Databases', code: '9662-B51E-5089', operation: 'cloudsql.instances.running', skuMeter: 'Cloud SQL for PostgreSQL: vCPU', skuId: '4B6D-7C15-9E22', unit: 'hour', resourceKind: 'instances', namespace: 'cloudsql.googleapis.com' },
    { name: 'Cloud Storage', category: 'Storage', subcategory: 'Object Storage', code: '95FF-2EF5-5EA1', operation: 'storage.objects.get', skuMeter: 'Standard Storage EU', skuId: 'E5F0-6A48-F9C1', unit: 'gibibyte month', resourceKind: 'buckets', namespace: 'storage.googleapis.com' },
    { name: 'Cloud Run', category: 'Compute', subcategory: 'Serverless Compute', code: '152E-C115-5142', operation: 'run.services.invoke', skuMeter: 'Cloud Run CPU Allocation Time', skuId: 'A1C3-9B27-4D65', unit: 'second', resourceKind: 'services', namespace: 'run.googleapis.com' },
    { name: 'BigQuery', category: 'Analytics', subcategory: 'Data Processing', code: '24E6-581D-38E5', operation: 'bigquery.jobs.query', skuMeter: 'Analysis', skuId: 'D5B1-8E44-70A9', unit: 'tebibyte', resourceKind: 'datasets', namespace: 'bigquery.googleapis.com' },
    { name: 'Google Kubernetes Engine', category: 'Compute', subcategory: 'Containers', code: 'CCD8-9BF1-090E', operation: 'container.clusters.running', skuMeter: 'Autopilot Pod vCPU', skuId: '7F3A-2C68-B04D', unit: 'hour', resourceKind: 'clusters', namespace: 'container.googleapis.com' },
  ],
  marketplacePublisher: 'Confluent, Inc.',
  marketplaceService: { name: 'Confluent Cloud', category: 'Analytics', subcategory: 'Streaming Analytics', code: 'C0AF-0C4B-3A1D', operation: 'marketplace.usage.report', skuMeter: 'Confluent Cloud eCKU', skuId: 'B8D2-1F35-6C07', unit: 'hour', resourceKind: 'clusters', namespace: 'cloudcommerceconsumerprocurement.googleapis.com' },
  commitmentId: 'cud-compute-n2-3yr-us-central1',
  commitmentName: 'Committed use discount: N2 vCPU (3 year)',
  commitmentType: 'Committed Use Discount',
  commitmentCategory: 'Usage',
  commitmentUnit: 'hour',
  // GCP labels are lowercase by API constraint; dashes replace spaces.
  tagKeys: { team: 'team', system: 'system', environment: 'environment' },
  resourceId: (service, region, account, seq) =>
    `//${service.namespace}/projects/${account.id}/${service.namespace === 'compute.googleapis.com' ? `zones/${region.id}-a` : `locations/${region.id}`}/${service.resourceKind}/${service.resourceKind.slice(0, -1)}-${String(seq).padStart(4, '0')}`,
  resourceName: (service, seq) => `${service.resourceKind.slice(0, -1)}-${String(seq).padStart(4, '0')}`,
};

const VOCABULARY: Record<SampleProvider, SampleVocabulary> = { aws: AWS, azure: AZURE, gcp: GCP };

/** Charge-category and description per event kind, shared across providers —
 *  FOCUS defines these values, so they do not vary by vendor. */
function chargeCategory(kind: EventKind): string {
  switch (kind) {
    case 'purchase': return 'Purchase';
    case 'tax': return 'Tax';
    case 'credit': return 'Credit';
    default: return 'Usage';
  }
}

function chargeDescription(kind: EventKind, vocab: SampleVocabulary, service: SampleService): string {
  switch (kind) {
    case 'committed-usage': return `${service.name} usage covered by ${vocab.commitmentName}`;
    case 'unused-commitment': return `Unused commitment: ${vocab.commitmentName}`;
    case 'purchase': return `${vocab.commitmentType} recurring fee — ${vocab.commitmentName}`;
    case 'tax': return 'VAT';
    case 'credit': return 'Promotional credit';
    case 'marketplace': return `${vocab.marketplacePublisher} — ${vocab.marketplaceService.skuMeter || 'metered usage'}`;
    case 'usage': return `${service.name} ${service.skuMeter}`;
  }
}

interface RenderContext {
  readonly event: BillingEvent;
  readonly vocab: SampleVocabulary;
  readonly service: SampleService;
  readonly account: SampleAccount;
  readonly region: SampleRegion;
  /** True for rows that consume nothing in a region: the month-span
   *  commitment, tax and credit charges. Region, unit and quantity are blank
   *  on those, exactly as a real export leaves them. */
  readonly resourceless: boolean;
  readonly resourceId: string;
  readonly resourceName: string;
  /** What the row's resource identifier points at: a workload resource, the
   *  commitment itself, or nothing. */
  readonly resourceRole: 'resource' | 'commitment' | 'none';
  readonly pricingCategory: string;
  readonly commitmentStatus: string;
}

function contextOf(event: BillingEvent, vocab: SampleVocabulary): RenderContext {
  const service = event.kind === 'marketplace'
    ? vocab.marketplaceService
    : at(vocab.services, event.serviceIdx);
  const account = at(vocab.accounts, event.accountIdx);
  const region = at(vocab.regions, event.regionIdx);
  const committed = event.kind === 'committed-usage' || event.kind === 'unused-commitment';
  const resourceless = event.kind === 'purchase' || event.kind === 'tax'
    || event.kind === 'credit' || event.kind === 'unused-commitment';

  // A commitment's own rows (the recurring fee and the unused share) point at
  // the commitment, not at any workload resource; tax and credits point at
  // nothing at all.
  const commitmentRow = event.kind === 'purchase' || event.kind === 'unused-commitment';
  const noResource = event.kind === 'tax' || event.kind === 'credit';

  return {
    event, vocab, service, account, region, resourceless,
    resourceId: commitmentRow ? vocab.commitmentId : noResource ? '' : vocab.resourceId(service, region, account, event.resourceSeq),
    resourceName: commitmentRow ? vocab.commitmentName : noResource ? '' : vocab.resourceName(service, event.resourceSeq),
    resourceRole: commitmentRow ? 'commitment' : noResource ? 'none' : 'resource',
    pricingCategory: committed ? 'Committed' : event.kind === 'usage' || event.kind === 'marketplace' ? 'Standard' : '',
    commitmentStatus: event.kind === 'committed-usage' ? 'Used' : event.kind === 'unused-commitment' ? 'Unused' : '',
  };
}

function jsonTags(tags: Readonly<Record<string, string>>, keys: SampleVocabulary['tagKeys']): string {
  const entries = Object.entries(tags).map(([k, v]) => {
    const key = k === 'team' ? keys.team : k === 'system' ? keys.system : keys.environment;
    return [key, v] as const;
  });
  return JSON.stringify(Object.fromEntries(entries));
}

/** GCP's repeated-record shape: `ARRAY<STRUCT<Key, Value>>`. */
function keyValueRecords(tags: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(tags).map(([Key, Value]) => ({ Key, Value })));
}

function awsRow(ctx: RenderContext): Record<string, string> {
  const { event, vocab, service, account, region } = ctx;
  const isCommitment = event.kind === 'committed-usage' || event.kind === 'unused-commitment' || event.kind === 'purchase';
  const publisher = event.kind === 'marketplace' ? vocab.marketplacePublisher : vocab.publisherName;
  return {
    BilledCost: event.billed.toFixed(2),
    BillingAccountId: vocab.billingAccountId,
    BillingAccountName: vocab.billingAccountName,
    BillingAccountType: vocab.billingAccountType,
    BillingCurrency: vocab.currency,
    BillingPeriodEnd: MONTH_END,
    BillingPeriodStart: MONTH_START,
    ChargeCategory: chargeCategory(event.kind),
    ChargeClass: '',
    ChargeDescription: chargeDescription(event.kind, vocab, service),
    ChargeFrequency: ctx.resourceless ? 'Recurring' : 'Usage-Based',
    ChargePeriodEnd: event.chargeEnd,
    ChargePeriodStart: event.chargeStart,
    CommitmentDiscountCategory: isCommitment ? vocab.commitmentCategory : '',
    CommitmentDiscountId: isCommitment ? vocab.commitmentId : '',
    CommitmentDiscountName: isCommitment ? vocab.commitmentName : '',
    CommitmentDiscountQuantity: isCommitment ? '2.000000' : '',
    CommitmentDiscountStatus: ctx.commitmentStatus,
    CommitmentDiscountType: isCommitment ? vocab.commitmentType : '',
    CommitmentDiscountUnit: isCommitment ? vocab.commitmentUnit : '',
    ConsumedQuantity: event.quantity.toFixed(3),
    ConsumedUnit: ctx.resourceless ? '' : service.unit,
    ContractedCost: event.contracted.toFixed(2),
    ContractedUnitPrice: event.quantity > 0 ? unitPrice(event.contracted / event.quantity).toFixed(6) : '',
    EffectiveCost: event.effective.toFixed(2),
    InvoiceId: '4419826371',
    InvoiceIssuerName: vocab.invoiceIssuerName,
    ListCost: event.list.toFixed(2),
    ListUnitPrice: event.quantity > 0 ? unitPrice(event.list / event.quantity).toFixed(6) : '',
    PricingCategory: ctx.pricingCategory,
    PricingQuantity: event.quantity.toFixed(3),
    PricingUnit: ctx.resourceless ? '' : service.unit,
    ProviderName: vocab.providerName,
    PublisherName: publisher,
    RegionId: ctx.resourceless ? '' : region.id,
    RegionName: ctx.resourceless ? '' : region.name,
    ResourceId: ctx.resourceId,
    ResourceName: ctx.resourceName,
    ResourceType: ctx.resourceRole === 'resource' ? service.resourceKind : ctx.resourceRole === 'commitment' ? vocab.commitmentType : '',
    ServiceCategory: service.category,
    ServiceName: service.name,
    ServiceSubcategory: service.subcategory,
    SkuId: service.skuId,
    SkuMeter: service.skuMeter,
    SkuPriceId: service.skuId === '' ? '' : `${service.skuId}.JRTCKXETXF`,
    SubAccountId: account.id,
    SubAccountName: account.name,
    SubAccountType: account.type,
    Tags: jsonTags(event.tags, vocab.tagKeys),
    // AWS reports negotiated discounts as a map rather than separate rows;
    // it is populated only where a discount actually applied.
    x_Discounts: event.list > 0 && event.contracted < event.list
      ? JSON.stringify({ 'Enterprise Discount Program': money(event.list - event.contracted) })
      : '{}',
    x_Operation: ctx.resourceless ? '' : service.operation,
    x_ServiceCode: service.code,
  };
}

function azureRow(ctx: RenderContext): Record<string, string> {
  const { event, vocab, service, account, region } = ctx;
  const isCommitment = event.kind === 'committed-usage' || event.kind === 'unused-commitment' || event.kind === 'purchase';
  const isMarketplace = event.kind === 'marketplace';
  // Microsoft bills in the customer's currency and republishes the USD
  // figure alongside it.
  const usd = (v: number): string => money(v * 1.09).toFixed(2);
  return {
    BilledCost: event.billed.toFixed(2),
    BillingAccountId: vocab.billingAccountId,
    BillingAccountName: vocab.billingAccountName,
    BillingAccountType: vocab.billingAccountType,
    BillingCurrency: vocab.currency,
    BillingPeriodEnd: MONTH_END,
    BillingPeriodStart: MONTH_START,
    CapacityReservationId: '',
    CapacityReservationStatus: '',
    ChargeCategory: chargeCategory(event.kind),
    ChargeClass: '',
    ChargeDescription: chargeDescription(event.kind, vocab, service),
    ChargeFrequency: ctx.resourceless ? 'Recurring' : 'Usage-Based',
    ChargePeriodEnd: event.chargeEnd,
    ChargePeriodStart: event.chargeStart,
    CommitmentDiscountCategory: isCommitment ? vocab.commitmentCategory : '',
    CommitmentDiscountId: isCommitment ? vocab.commitmentId : '',
    CommitmentDiscountName: isCommitment ? vocab.commitmentName : '',
    CommitmentDiscountQuantity: isCommitment ? '4.000000' : '',
    CommitmentDiscountStatus: ctx.commitmentStatus,
    CommitmentDiscountType: isCommitment ? vocab.commitmentType : '',
    CommitmentDiscountUnit: isCommitment ? vocab.commitmentUnit : '',
    ConsumedQuantity: event.quantity.toFixed(3),
    ConsumedUnit: ctx.resourceless ? '' : service.unit,
    ContractedCost: event.contracted.toFixed(2),
    ContractedUnitPrice: event.quantity > 0 ? unitPrice(event.contracted / event.quantity).toFixed(6) : '',
    EffectiveCost: event.effective.toFixed(2),
    InvoiceId: 'G019283746',
    InvoiceIssuerName: vocab.invoiceIssuerName,
    ListCost: event.list.toFixed(2),
    ListUnitPrice: event.quantity > 0 ? unitPrice(event.list / event.quantity).toFixed(6) : '',
    PricingCategory: ctx.pricingCategory,
    PricingCurrency: vocab.currency,
    PricingQuantity: event.quantity.toFixed(3),
    PricingUnit: ctx.resourceless ? '' : service.unit,
    ProviderName: vocab.providerName,
    PublisherName: isMarketplace ? vocab.marketplacePublisher : vocab.publisherName,
    RegionId: ctx.resourceless ? '' : region.id,
    RegionName: ctx.resourceless ? '' : region.name,
    ResourceId: ctx.resourceId,
    ResourceName: ctx.resourceName,
    // Azure reports the ARM resource type.
    ResourceType: ctx.resourceRole === 'resource' ? service.operation : ctx.resourceRole === 'commitment' ? vocab.commitmentType : '',
    ServiceCategory: service.category,
    ServiceName: service.name,
    ServiceSubcategory: service.subcategory,
    SkuId: service.skuId,
    SkuMeter: service.skuMeter,
    SkuPriceDetails: ctx.resourceless ? '' : JSON.stringify({ MeterId: service.skuId, TierMinimumUnits: 0 }),
    SkuPriceId: service.skuId === '' ? '' : `${service.skuId}/${service.skuMeter.replace(/ /g, '-')}`,
    SubAccountId: account.id,
    SubAccountName: account.name,
    SubAccountType: account.type,
    // Azure delivers Tags as a JSON document, not a key/value map.
    Tags: jsonTags(event.tags, vocab.tagKeys),
    x_AccountName: account.name,
    x_BilledCostInUsd: usd(event.billed),
    x_BillingProfileName: 'Acme Corp Billing Profile',
    x_CostCenter: 'cc-2087',
    x_EffectiveCostInUsd: usd(event.effective),
    x_InvoiceSectionName: 'Engineering',
    x_PublisherCategory: isMarketplace ? 'Marketplace' : 'Microsoft',
    x_ResourceGroupName: ctx.resourceless ? '' : `rg-acme-${service.resourceKind.toLowerCase()}`,
    x_SkuMeterCategory: service.name,
    x_SkuMeterName: service.skuMeter,
    x_SkuServiceFamily: service.code,
  };
}

function gcpRow(ctx: RenderContext): Record<string, string> {
  const { event, vocab, service, account, region } = ctx;
  const isCommitment = event.kind === 'committed-usage' || event.kind === 'unused-commitment';
  // GCP surfaces commitment coverage as a credit entry on the usage row —
  // there are no CommitmentDiscount* columns to carry it.
  const credits = isCommitment
    ? [{ Id: vocab.commitmentId, FullName: vocab.commitmentName, Type: 'COMMITTED_USAGE_DISCOUNT', Name: vocab.commitmentName, Amount: money(event.effective - event.list) }]
    : event.kind === 'credit'
      ? [{ Id: 'promo-2026-05', FullName: 'Promotional credit', Type: 'PROMOTION', Name: 'Promotional credit', Amount: event.billed }]
      : [];
  return {
    // Only Compute Engine rows are zonal; everything else is regional.
    AvailabilityZone: ctx.resourceless || service.namespace !== 'compute.googleapis.com' ? '' : `${region.id}-a`,
    BilledCost: event.billed.toFixed(2),
    BillingAccountId: vocab.billingAccountId,
    BillingAccountType: vocab.billingAccountType,
    BillingCurrency: vocab.currency,
    BillingPeriodEnd: MONTH_END,
    BillingPeriodStart: MONTH_START,
    ChargeCategory: chargeCategory(event.kind),
    ChargeClass: '',
    ChargeDescription: chargeDescription(event.kind, vocab, service),
    ChargePeriodEnd: event.chargeEnd,
    ChargePeriodStart: event.chargeStart,
    ConsumedQuantity: event.quantity.toFixed(3),
    ConsumedUnit: ctx.resourceless ? '' : service.unit,
    ContractedCost: event.contracted.toFixed(2),
    ContractedUnitPrice: event.quantity > 0 ? unitPrice(event.contracted / event.quantity).toFixed(6) : '',
    EffectiveCost: event.effective.toFixed(2),
    ListCost: event.list.toFixed(2),
    ListUnitPrice: event.quantity > 0 ? unitPrice(event.list / event.quantity).toFixed(6) : '',
    PricingCategory: ctx.pricingCategory,
    PricingCurrency: vocab.currency,
    PricingCurrencyContractedUnitPrice: event.quantity > 0 ? unitPrice(event.contracted / event.quantity).toFixed(6) : '',
    PricingCurrencyEffectiveCost: event.effective.toFixed(2),
    PricingCurrencyListUnitPrice: event.quantity > 0 ? unitPrice(event.list / event.quantity).toFixed(6) : '',
    PricingQuantity: event.quantity.toFixed(3),
    PricingUnit: ctx.resourceless ? '' : service.unit,
    ProviderName: vocab.providerName,
    PublisherName: event.kind === 'marketplace' ? vocab.marketplacePublisher : vocab.publisherName,
    RegionId: ctx.resourceless ? '' : region.id,
    RegionName: ctx.resourceless ? '' : region.name,
    ResourceId: ctx.resourceId,
    ResourceName: ctx.resourceName,
    ServiceName: service.name,
    SkuId: service.skuId,
    SkuPriceId: service.skuId === '' ? '' : `${service.skuId}-price`,
    SubAccountId: account.id,
    SubAccountName: account.name,
    x_ConsumptionModelId: '',
    x_CostType: event.kind === 'tax' ? 'tax' : event.kind === 'credit' ? 'adjustment' : 'regular',
    x_Credits: JSON.stringify(credits),
    x_CurrencyConversionRate: '1.000000',
    x_ExportTime: '2026-06-02 04:17:33',
    // Resource labels — the tags a GCP user actually sets on a resource.
    x_Labels: keyValueRecords(event.tags),
    x_Location: ctx.resourceless ? 'global' : region.id,
    x_Project: JSON.stringify({ Id: account.id, Name: account.name, Number: `12345678900${String(event.accountIdx)}` }),
    x_ProjectLabels: JSON.stringify([{ Key: 'cost-center', Value: 'cc-2087' }]),
    x_ServiceId: service.code,
    x_SubscriptionInstanceId: '',
    x_SystemLabels: ctx.resourceless
      ? '[]'
      : JSON.stringify([{ Key: 'compute.googleapis.com/machine_spec', Value: 'n2-standard-4' }]),
    // Tag bindings (the org-policy kind) — distinct from labels, and the
    // higher-precedence source when both carry the same key.
    x_Tags: JSON.stringify([{ Key: 'environment', Value: 'production', x_Inherited: false, x_Namespace: '123456789012/environment' }]),
  };
}

const RENDERERS: Record<SampleProvider, (ctx: RenderContext) => Record<string, string>> = {
  aws: awsRow,
  azure: azureRow,
  gcp: gcpRow,
};

/** Rows of one provider's sample, keyed by native column name. */
export function sampleRows(provider: SampleProvider): readonly Readonly<Record<string, string>>[] {
  const vocab = VOCABULARY[provider];
  const render = RENDERERS[provider];
  return billingEvents().map(event => render(contextOf(event, vocab)));
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One provider's sample serialized as CSV — the exact bytes committed under
 *  `samples/`. */
export function buildSampleCsv(provider: SampleProvider): string {
  const columns = NATIVE_COLUMNS[provider];
  const lines = [columns.join(',')];
  for (const row of sampleRows(provider)) {
    lines.push(columns.map(col => csvCell(row[col] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}
