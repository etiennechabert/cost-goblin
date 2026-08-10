/** Shared FOCUS 1.2 synthetic-fixture machinery.
 *
 *  Both fixture generators — setup.ts (vitest, on-demand) and generate.ts
 *  (CLI, used by CI for e2e) — build the same `synthetic` DuckDB table
 *  through this module so the emitted schema can never drift between the
 *  two test stacks.
 *
 *  The column set mirrors the app's ingest contract: every FOCUS 1.2 column
 *  the query layer reads (verified against a live AWS FOCUS 1.2 Data
 *  Export), with the same physical types (UTC timestamps, MAP tags). The
 *  full AWS export carries ~60 columns; the extras are ignored by
 *  buildSource and deliberately not emitted here to keep fixtures lean.
 *
 *  Row populations deliberately include the shapes a real bill has that the
 *  smoke-test account lacks, so commitment/marketplace/discount handling
 *  stays covered by tests:
 *    - standard on-demand usage (bulk; all four cost columns close in value)
 *    - commitment-covered usage  (PricingCategory='Committed', Status='Used',
 *      BilledCost=0 — the invoiced amount sits on Purchase rows)
 *    - unused commitment         (Status='Unused', EffectiveCost only,
 *      untagged, attached to the commitment resource)
 *    - commitment purchases      (ChargeCategory='Purchase', BilledCost only,
 *      month-span charge period)
 *    - tax                       (ChargeCategory='Tax', month-span)
 *    - credits                   (ChargeCategory='Credit', negative)
 *    - marketplace               (empty x_ServiceCode/ServiceName, publisher
 *      set, ListCost=0 — exercises marketplace re-attribution) */

import { SERVICE_META, DEFAULT_META } from './service-meta.js';

export interface FixtureService {
  readonly code: string;
  readonly costShare: number;
  /** FOCUS ServiceName override for codes absent from SERVICE_META (e.g.
   *  profiled real-data services) — keeps generated ServiceName faithful
   *  instead of collapsing to DEFAULT_META's "Unknown Service". */
  readonly name?: string | undefined;
}
export interface FixtureAccount { readonly id: string; readonly name: string; readonly costShare: number }

export interface FocusFixtureConfig {
  readonly services: readonly FixtureService[];
  readonly accounts: readonly FixtureAccount[];
  readonly regions: readonly string[];
  readonly owners: readonly string[];
  readonly products: readonly string[];
  readonly envs: readonly string[];
}

export type Rand = () => number;

export function seededRandom(seed: number): Rand {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function pick<T>(arr: readonly T[], rand: Rand): T {
  const idx = Math.floor(rand() * arr.length);
  const item = arr[idx];
  if (item === undefined) throw new Error('pick: empty array');
  return item;
}

export function weightedPick<T extends { readonly costShare: number }>(arr: readonly T[], rand: Rand): T {
  const r = rand();
  let cumulative = 0;
  for (const item of arr) {
    cumulative += item.costShare;
    if (r <= cumulative) return item;
  }
  const last = arr.at(-1);
  if (last === undefined) throw new Error('weightedPick: empty array');
  return last;
}

export const FOCUS_TABLE_DDL = `
    CREATE TABLE synthetic (
      ChargePeriodStart TIMESTAMP,
      ChargePeriodEnd TIMESTAMP,
      BillingPeriodStart TIMESTAMP,
      BillingAccountId VARCHAR,
      SubAccountId VARCHAR,
      SubAccountName VARCHAR,
      RegionId VARCHAR,
      RegionName VARCHAR,
      ServiceName VARCHAR,
      ServiceCategory VARCHAR,
      ChargeDescription VARCHAR,
      ChargeCategory VARCHAR,
      ChargeClass VARCHAR,
      PricingCategory VARCHAR,
      CommitmentDiscountId VARCHAR,
      CommitmentDiscountName VARCHAR,
      CommitmentDiscountStatus VARCHAR,
      CommitmentDiscountType VARCHAR,
      ConsumedQuantity DOUBLE,
      ConsumedUnit VARCHAR,
      ResourceId VARCHAR,
      ResourceName VARCHAR,
      ResourceType VARCHAR,
      BilledCost DOUBLE,
      EffectiveCost DOUBLE,
      ListCost DOUBLE,
      ContractedCost DOUBLE,
      PublisherName VARCHAR,
      InvoiceIssuerName VARCHAR,
      SkuMeter VARCHAR,
      Tags MAP(VARCHAR, VARCHAR),
      x_Operation VARCHAR,
      x_ServiceCode VARCHAR,
      ProviderName VARCHAR,
      BillingCurrency VARCHAR
    )`;

const INVOICE_ISSUER = 'Amazon Web Services EMEA SARL';

function sq(v: string): string {
  return `'${v.replaceAll("'", "''")}'`;
}

/** Round to cents. Shared with the focus-1-2 provider samples so both
 *  generators agree on cent boundaries. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

interface FocusRow {
  readonly chargePeriodStart: string;
  readonly chargePeriodEnd: string;
  readonly billingPeriodStart: string;
  readonly billingAccountId: string;
  readonly subAccountId: string;
  readonly subAccountName: string;
  readonly regionId: string;
  readonly regionName: string;
  readonly serviceName: string;
  readonly serviceCategory: string;
  readonly chargeDescription: string;
  readonly chargeCategory: string;
  readonly chargeClass: string | null;
  readonly pricingCategory: string | null;
  readonly commitmentDiscountId: string | null;
  readonly commitmentDiscountName: string | null;
  readonly commitmentDiscountStatus: string | null;
  readonly commitmentDiscountType: string | null;
  readonly consumedQuantity: number;
  readonly consumedUnit: string;
  readonly resourceId: string;
  readonly resourceName: string | null;
  readonly resourceType: string | null;
  readonly billedCost: number;
  readonly effectiveCost: number;
  readonly listCost: number;
  readonly contractedCost: number;
  readonly publisherName: string;
  readonly skuMeter: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly operation: string;
  readonly serviceCode: string;
}

function renderRow(r: FocusRow): string {
  const tagEntries = Object.entries(r.tags).map(([k, v]) => `${sq(k)}: ${sq(v)}`);
  const nullable = (v: string | null): string => (v === null ? 'NULL' : sq(v));
  return `(TIMESTAMP ${sq(r.chargePeriodStart)}, TIMESTAMP ${sq(r.chargePeriodEnd)}, TIMESTAMP ${sq(r.billingPeriodStart)}, ` +
    `${sq(r.billingAccountId)}, ${sq(r.subAccountId)}, ${sq(r.subAccountName)}, ` +
    `${sq(r.regionId)}, ${sq(r.regionName)}, ${sq(r.serviceName)}, ${sq(r.serviceCategory)}, ${sq(r.chargeDescription)}, ` +
    `${sq(r.chargeCategory)}, ${nullable(r.chargeClass)}, ${nullable(r.pricingCategory)}, ` +
    `${nullable(r.commitmentDiscountId)}, ${nullable(r.commitmentDiscountName)}, ${nullable(r.commitmentDiscountStatus)}, ${nullable(r.commitmentDiscountType)}, ` +
    `${String(r.consumedQuantity)}, ${sq(r.consumedUnit)}, ${sq(r.resourceId)}, ${nullable(r.resourceName)}, ${nullable(r.resourceType)}, ` +
    `${String(r.billedCost)}, ${String(r.effectiveCost)}, ${String(r.listCost)}, ${String(r.contractedCost)}, ` +
    `${sq(r.publisherName)}, ${sq(INVOICE_ISSUER)}, ${sq(r.skuMeter)}, MAP {${tagEntries.join(', ')}}, ` +
    `${sq(r.operation)}, ${sq(r.serviceCode)}, 'AWS', 'USD')`;
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function monthStart(date: string): string {
  return `${monthOf(date)}-01`;
}

function monthEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const next = m === 12 ? `${String(y + 1)}-01-01` : `${String(y)}-${String(m + 1).padStart(2, '0')}-01`;
  return next;
}

function pickTags(cfg: FocusFixtureConfig, rand: Rand): Record<string, string> {
  const tags: Record<string, string> = {};
  if (rand() >= 0.08) tags['team'] = pick(cfg.owners, rand);
  if (rand() >= 0.12) tags['system'] = pick(cfg.products, rand);
  if (rand() >= 0.03) tags['environment'] = pick(cfg.envs, rand);
  return tags;
}

/** The payer account: unused commitment, purchases, tax and credits attach
 *  here, like they do on a real consolidated bill. */
function payerAccount(cfg: FocusFixtureConfig): FixtureAccount {
  const first = cfg.accounts[0];
  if (first === undefined) throw new Error('fixture config needs at least one account');
  return first;
}

function standardUsageRow(date: string, cfg: FocusFixtureConfig, rand: Rand): string {
  const service = weightedPick(cfg.services, rand);
  const account = weightedPick(cfg.accounts, rand);
  const region = pick(cfg.regions, rand);
  const base = SERVICE_META[service.code] ?? DEFAULT_META;
  const meta = service.name !== undefined && SERVICE_META[service.code] === undefined
    ? { ...base, serviceName: service.name }
    : base;
  const operation = pick(meta.operations, rand);
  const effective = round2(Math.exp(rand() * 6 - 2) * service.costShare * 10);
  const list = round2(effective * (1 + rand() * 0.3));
  const qty = round2(rand() * 1000);
  return renderRow({
    chargePeriodStart: date, chargePeriodEnd: date, billingPeriodStart: monthStart(date),
    billingAccountId: payerAccount(cfg).id, subAccountId: account.id, subAccountName: account.name,
    regionId: region, regionName: region, serviceName: meta.serviceName, serviceCategory: meta.category,
    chargeDescription: `${service.code} ${operation} usage`,
    chargeCategory: 'Usage', chargeClass: null, pricingCategory: 'Standard',
    commitmentDiscountId: null, commitmentDiscountName: null, commitmentDiscountStatus: null, commitmentDiscountType: null,
    consumedQuantity: qty, consumedUnit: 'Hrs',
    resourceId: `arn:aws:${service.code.toLowerCase()}:${region}:${account.id}:resource/${String(Math.floor(rand() * 10000))}`,
    resourceName: null, resourceType: null,
    billedCost: effective, effectiveCost: effective, listCost: list, contractedCost: effective,
    publisherName: INVOICE_ISSUER, skuMeter: `${region.toUpperCase().slice(0, 4)}-BoxUsage`,
    tags: pickTags(cfg, rand), operation, serviceCode: service.code,
  });
}

/** Commitment-covered usage: BilledCost=0 (the invoice charge sits on the
 *  Purchase row), EffectiveCost carries the amortized share. */
function committedUsageRow(date: string, cfg: FocusFixtureConfig, rand: Rand, commitmentId: string): string {
  const service = cfg.services[0] ?? { code: 'AmazonEC2', costShare: 1 };
  const account = weightedPick(cfg.accounts, rand);
  const region = pick(cfg.regions, rand);
  const meta = SERVICE_META[service.code] ?? DEFAULT_META;
  const effective = round2(1 + rand() * 4);
  const list = round2(effective * 1.4);
  return renderRow({
    chargePeriodStart: date, chargePeriodEnd: date, billingPeriodStart: monthStart(date),
    billingAccountId: payerAccount(cfg).id, subAccountId: account.id, subAccountName: account.name,
    regionId: region, regionName: region, serviceName: meta.serviceName, serviceCategory: meta.category,
    chargeDescription: 'Savings Plan covered usage',
    chargeCategory: 'Usage', chargeClass: null, pricingCategory: 'Committed',
    commitmentDiscountId: commitmentId, commitmentDiscountName: 'compute-sp-1',
    commitmentDiscountStatus: 'Used', commitmentDiscountType: 'SavingsPlan',
    consumedQuantity: round2(rand() * 24), consumedUnit: 'Hrs',
    resourceId: `arn:aws:ec2:${region}:${account.id}:instance/i-${String(Math.floor(rand() * 100000))}`,
    resourceName: null, resourceType: 'instance',
    billedCost: 0, effectiveCost: effective, listCost: list, contractedCost: round2(list * 0.95),
    publisherName: INVOICE_ISSUER, skuMeter: `${region.toUpperCase().slice(0, 4)}-BoxUsage`,
    tags: pickTags(cfg, rand), operation: 'RunInstances', serviceCode: service.code,
  });
}

/** The unused share of a commitment: EffectiveCost only, untagged, attached
 *  to the payer and the commitment resource — this is the population the
 *  CUR-era amortized expression silently dropped. */
function unusedCommitmentRow(date: string, cfg: FocusFixtureConfig, rand: Rand, commitmentId: string): string {
  const payer = payerAccount(cfg);
  const effective = round2(0.5 + rand() * 2);
  return renderRow({
    chargePeriodStart: date, chargePeriodEnd: date, billingPeriodStart: monthStart(date),
    billingAccountId: payer.id, subAccountId: payer.id, subAccountName: payer.name,
    regionId: '', regionName: '', serviceName: 'Savings Plans for AWS Compute usage', serviceCategory: 'Compute',
    chargeDescription: 'Unused Savings Plan commitment',
    chargeCategory: 'Usage', chargeClass: null, pricingCategory: 'Committed',
    commitmentDiscountId: commitmentId, commitmentDiscountName: 'compute-sp-1',
    commitmentDiscountStatus: 'Unused', commitmentDiscountType: 'SavingsPlan',
    consumedQuantity: 0, consumedUnit: 'Hrs',
    resourceId: commitmentId, resourceName: 'compute-sp-1', resourceType: 'savings-plan',
    billedCost: 0, effectiveCost: effective, listCost: 0, contractedCost: 0,
    publisherName: INVOICE_ISSUER, skuMeter: 'ComputeSP:AllUsage',
    tags: {}, operation: '', serviceCode: 'ComputeSavingsPlans',
  });
}

/** Monthly recurring commitment purchase: the invoiced fee. BilledCost only —
 *  EffectiveCost is 0 because the amortization lives on Used/Unused rows. */
function purchaseRow(month: string, cfg: FocusFixtureConfig, commitmentId: string, amount: number): string {
  const payer = payerAccount(cfg);
  const start = `${month}-01`;
  return renderRow({
    chargePeriodStart: start, chargePeriodEnd: monthEnd(start), billingPeriodStart: start,
    billingAccountId: payer.id, subAccountId: payer.id, subAccountName: payer.name,
    regionId: '', regionName: '', serviceName: 'Savings Plans for AWS Compute usage', serviceCategory: 'Compute',
    chargeDescription: 'Savings Plan recurring fee',
    chargeCategory: 'Purchase', chargeClass: null, pricingCategory: null,
    commitmentDiscountId: commitmentId, commitmentDiscountName: 'compute-sp-1',
    commitmentDiscountStatus: null, commitmentDiscountType: 'SavingsPlan',
    consumedQuantity: 0, consumedUnit: '',
    resourceId: commitmentId, resourceName: 'compute-sp-1', resourceType: 'savings-plan',
    billedCost: amount, effectiveCost: 0, listCost: 0, contractedCost: 0,
    publisherName: INVOICE_ISSUER, skuMeter: '',
    tags: {}, operation: '', serviceCode: 'ComputeSavingsPlans',
  });
}

/** Month-span tax row (real FOCUS exports deliver Tax with a month-long
 *  charge period, so it lands on day 1 of the month at daily grain). */
function taxRow(month: string, cfg: FocusFixtureConfig, amount: number): string {
  const payer = payerAccount(cfg);
  const start = `${month}-01`;
  return renderRow({
    chargePeriodStart: start, chargePeriodEnd: monthEnd(start), billingPeriodStart: start,
    billingAccountId: payer.id, subAccountId: payer.id, subAccountName: payer.name,
    regionId: '', regionName: '', serviceName: 'Tax', serviceCategory: 'Other',
    chargeDescription: 'VAT',
    chargeCategory: 'Tax', chargeClass: null, pricingCategory: null,
    commitmentDiscountId: null, commitmentDiscountName: null, commitmentDiscountStatus: null, commitmentDiscountType: null,
    consumedQuantity: 0, consumedUnit: '',
    resourceId: '', resourceName: null, resourceType: null,
    billedCost: amount, effectiveCost: amount, listCost: 0, contractedCost: amount,
    publisherName: INVOICE_ISSUER, skuMeter: '',
    tags: {}, operation: '', serviceCode: 'AWSTax',
  });
}

/** Negative credit row. */
function creditRow(month: string, cfg: FocusFixtureConfig, amount: number): string {
  const payer = payerAccount(cfg);
  const start = `${month}-01`;
  return renderRow({
    chargePeriodStart: start, chargePeriodEnd: monthEnd(start), billingPeriodStart: start,
    billingAccountId: payer.id, subAccountId: payer.id, subAccountName: payer.name,
    regionId: '', regionName: '', serviceName: 'Amazon Elastic Compute Cloud', serviceCategory: 'Compute',
    chargeDescription: 'AWS promotional credit',
    chargeCategory: 'Credit', chargeClass: null, pricingCategory: null,
    commitmentDiscountId: null, commitmentDiscountName: null, commitmentDiscountStatus: null, commitmentDiscountType: null,
    consumedQuantity: 0, consumedUnit: '',
    resourceId: '', resourceName: null, resourceType: null,
    billedCost: -amount, effectiveCost: -amount, listCost: 0, contractedCost: -amount,
    publisherName: INVOICE_ISSUER, skuMeter: '',
    tags: {}, operation: '', serviceCode: 'AmazonEC2',
  });
}

/** Marketplace row (Bedrock third-party model inference shape): empty
 *  x_ServiceCode/ServiceName, publisher set, no list price. Exercises the
 *  marketplace re-attribution CASE and the list-metric fallback. */
function marketplaceRow(date: string, cfg: FocusFixtureConfig, rand: Rand): string {
  const account = weightedPick(cfg.accounts, rand);
  const region = pick(cfg.regions, rand);
  const cost = round2(0.5 + rand() * 3);
  return renderRow({
    chargePeriodStart: date, chargePeriodEnd: date, billingPeriodStart: monthStart(date),
    billingAccountId: payerAccount(cfg).id, subAccountId: account.id, subAccountName: account.name,
    regionId: region, regionName: region, serviceName: '', serviceCategory: 'AI and Machine Learning',
    chargeDescription: 'Claude Sonnet inference (per-token)',
    chargeCategory: 'Usage', chargeClass: null, pricingCategory: 'Standard',
    commitmentDiscountId: null, commitmentDiscountName: null, commitmentDiscountStatus: null, commitmentDiscountType: null,
    consumedQuantity: round2(rand() * 1_000_000), consumedUnit: 'tokens',
    resourceId: '', resourceName: null, resourceType: null,
    billedCost: cost, effectiveCost: cost, listCost: 0, contractedCost: cost,
    publisherName: 'Anthropic', skuMeter: '',
    tags: pickTags(cfg, rand), operation: 'InvokeModelInference', serviceCode: '',
  });
}

export interface FocusRowCounts {
  readonly standardPerDay: number;
  readonly committedPerDay: number;
  readonly marketplacePerDay: number;
}

export const DEFAULT_ROW_COUNTS: FocusRowCounts = {
  standardPerDay: 46,
  committedPerDay: 2,
  marketplacePerDay: 1,
};

const COMMITMENT_ID = 'arn:aws:savingsplans::100000000000:savingsplan/sp-fixture-1';

/** Render every VALUES tuple for the synthetic table: per-day usage rows
 *  (standard, committed, unused-commitment, marketplace) plus per-month
 *  billing events (purchase, tax, credit). Deterministic under a seeded
 *  `rand`. */
export function generateFocusRows(
  dates: readonly string[],
  cfg: FocusFixtureConfig,
  rand: Rand,
  counts: FocusRowCounts = DEFAULT_ROW_COUNTS,
): string[] {
  const rows: string[] = [];
  for (const date of dates) {
    for (let i = 0; i < counts.standardPerDay; i++) rows.push(standardUsageRow(date, cfg, rand));
    for (let i = 0; i < counts.committedPerDay; i++) rows.push(committedUsageRow(date, cfg, rand, COMMITMENT_ID));
    rows.push(unusedCommitmentRow(date, cfg, rand, COMMITMENT_ID));
    for (let i = 0; i < counts.marketplacePerDay; i++) rows.push(marketplaceRow(date, cfg, rand));
  }
  for (const month of new Set(dates.map(monthOf))) {
    rows.push(purchaseRow(month, cfg, COMMITMENT_ID, 120), taxRow(month, cfg, 250), creditRow(month, cfg, 75));
  }
  return rows;
}

/** Create + populate the `synthetic` table on an open DuckDB connection. */
export async function buildSyntheticTable(
  conn: { run: (sql: string) => Promise<unknown> },
  dates: readonly string[],
  cfg: FocusFixtureConfig,
  rand: Rand,
  counts: FocusRowCounts = DEFAULT_ROW_COUNTS,
): Promise<number> {
  await conn.run(FOCUS_TABLE_DDL);
  const rows = generateFocusRows(dates, cfg, rand, counts);
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await conn.run(`INSERT INTO synthetic VALUES ${rows.slice(i, i + BATCH_SIZE).join(',')}`);
  }
  return rows.length;
}
