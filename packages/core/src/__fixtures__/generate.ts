import { DuckDBInstance } from '@duckdb/node-api';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { buildSyntheticTable, seededRandom } from './focus-fixture.js';
import type { FocusFixtureConfig } from './focus-fixture.js';
import { FIXTURE_PROVIDER_NAME } from './layout.js';
import { writeGcpProvider } from './gcp-fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', '..', 'data');
const RAW_DATA = join(DATA_DIR, 'raw');
const FIXTURES_DIR = __dirname;
const SYNTHETIC_DIR = join(FIXTURES_DIR, 'synthetic');
const PROFILE_PATH = join(DATA_DIR, 'profile.json');
const DIMENSIONS_PATH = join(DATA_DIR, 'config', 'dimensions.yaml');

interface TagDimensionDef {
  readonly tagName: string;
  readonly concept?: string | undefined;
}

async function loadTagDefs(): Promise<TagDimensionDef[]> {
  const raw = await readFile(DIMENSIONS_PATH, 'utf-8');
  const config = parseYaml(raw) as { tags: TagDimensionDef[] };
  return config.tags;
}

interface Profile {
  rowCount: number;
  dateRange: { min: string; max: string };
  services: { code: string; name: string; costShare: number; avgDailyCost: number }[];
  accounts: { id: string; name: string; costShare: number }[];
  regions: string[];
  tags: Record<string, { values: string[]; missingPercent: number }>;
  costDistribution: { p50: number; p90: number; p99: number };
  chargeCategories: Record<string, number>;
}

const DEFAULT_PROFILE: Profile = {
  rowCount: 1000000,
  dateRange: { min: '2026-01-01', max: '2026-03-01' },
  services: [
    { code: 'AmazonEC2', name: 'Amazon Elastic Compute Cloud', costShare: 0.25, avgDailyCost: 500 },
    { code: 'AmazonRDS', name: 'Amazon Relational Database Service', costShare: 0.15, avgDailyCost: 300 },
    { code: 'AmazonS3', name: 'Amazon Simple Storage Service', costShare: 0.08, avgDailyCost: 160 },
    { code: 'AmazonCloudWatch', name: 'AmazonCloudWatch', costShare: 0.06, avgDailyCost: 120 },
    { code: 'AmazonDynamoDB', name: 'Amazon DynamoDB', costShare: 0.05, avgDailyCost: 100 },
    { code: 'AWSELB', name: 'Elastic Load Balancing', costShare: 0.05, avgDailyCost: 100 },
    { code: 'AmazonECS', name: 'Amazon EC2 Container Service', costShare: 0.04, avgDailyCost: 80 },
    { code: 'AmazonVPC', name: 'Amazon Virtual Private Cloud', costShare: 0.04, avgDailyCost: 80 },
    { code: 'AWSBackup', name: 'AWS Backup', costShare: 0.03, avgDailyCost: 60 },
    { code: 'AmazonElastiCache', name: 'Amazon ElastiCache', costShare: 0.03, avgDailyCost: 60 },
    { code: 'awskms', name: 'AWS Key Management Service', costShare: 0.02, avgDailyCost: 40 },
    { code: 'AWSXRay', name: 'AWS X-Ray', costShare: 0.02, avgDailyCost: 40 },
    { code: 'AmazonGuardDuty', name: 'Amazon GuardDuty', costShare: 0.02, avgDailyCost: 40 },
    { code: 'AWSSecurityHub', name: 'AWS Security Hub', costShare: 0.01, avgDailyCost: 20 },
    { code: 'AmazonConnect', name: 'Amazon Connect', costShare: 0.01, avgDailyCost: 20 },
  ],
  accounts: [
    { id: '100000000000', name: 'Main Production', costShare: 0.45 },
    { id: '100000000001', name: 'Data Platform', costShare: 0.12 },
    { id: '100000000002', name: 'Payments Production', costShare: 0.08 },
    { id: '100000000003', name: 'Identity Production', costShare: 0.06 },
    { id: '100000000004', name: 'Platform Engineering', costShare: 0.05 },
    { id: '100000000005', name: 'Security Operations', costShare: 0.04 },
    { id: '100000000006', name: 'CI/CD Platform', costShare: 0.04 },
    { id: '100000000007', name: 'Staging Shared', costShare: 0.04 },
    { id: '100000000008', name: 'Development Sandbox', costShare: 0.03 },
    { id: '100000000009', name: 'Networking', costShare: 0.03 },
    { id: '100000000010', name: 'Disaster Recovery', costShare: 0.02 },
    { id: '100000000011', name: 'Monitoring', costShare: 0.015 },
    { id: '100000000012', name: 'Logging', costShare: 0.015 },
    { id: '100000000013', name: 'Billing Production', costShare: 0.01 },
    { id: '100000000014', name: 'Cards Production', costShare: 0.01 },
  ],
  regions: [
    'us-east-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'ap-northeast-1',
  ],
  tags: {
    owner: { values: ['backend', 'frontend', 'platform', 'data-eng', 'security', 'payments', 'identity', 'sre'], missingPercent: 0.08 },
    product: { values: ['api-gateway', 'auth-service', 'billing-engine', 'data-pipeline', 'event-bus', 'ledger', 'payment-router', 'risk-engine'], missingPercent: 0.12 },
    environment: { values: ['production', 'staging', 'testing', 'sandbox'], missingPercent: 0.03 },
  },
  costDistribution: { p50: 0.000005, p90: 0.012, p99: 0.86 },
  chargeCategories: { Usage: 0.95, Tax: 0.002, Purchase: 0.008, Credit: 0.04 },
};

async function queryAll(conn: { run: (sql: string) => Promise<{ columnCount: number; columnName: (i: number) => string; fetchChunk: () => Promise<{ rowCount: number; getColumnVector: (i: number) => { getItem: (r: number) => unknown } } | null> }> }, sql: string): Promise<Record<string, unknown>[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: Record<string, unknown>[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (let c = 0; c < cols; c++) {
        const name = names[c];
        if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
      }
      rows.push(row);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

/** Profile a real FOCUS 1.2 export dropped under data/raw/ (any nesting —
 *  matched by the billing_period= Hive dir the AWS export delivers). */
async function profile(): Promise<void> {
  process.stdout.write('Profiling real data...\n');
  const db = await DuckDBInstance.create();
  const conn = await db.connect();
  const src = `read_parquet('${RAW_DATA}/**/*.parquet', union_by_name=true)`;

  const [countRow] = await queryAll(conn, `SELECT COUNT(*) as cnt FROM ${src}`);
  const rowCount = Number(countRow?.['cnt'] ?? 0);

  const [dateRow] = await queryAll(conn, `SELECT MIN(ChargePeriodStart)::DATE::VARCHAR as mn, MAX(ChargePeriodEnd)::DATE::VARCHAR as mx FROM ${src}`);

  const totalCostRows = await queryAll(conn, `SELECT SUM(EffectiveCost) as total FROM ${src}`);
  const totalCost = Number(totalCostRows[0]?.['total'] ?? 1);
  const days = 30;

  const serviceRows = await queryAll(conn, `
    SELECT x_ServiceCode as code, ANY_VALUE(ServiceName) as name, SUM(EffectiveCost) as total
    FROM ${src}
    WHERE x_ServiceCode IS NOT NULL AND x_ServiceCode != ''
    GROUP BY x_ServiceCode ORDER BY total DESC LIMIT 20
  `);
  const services = serviceRows.map(r => ({
    code: String(r['code']),
    name: String(r['name']),
    costShare: Number(r['total']) / totalCost,
    avgDailyCost: Number(r['total']) / days,
  }));

  const accountRows = await queryAll(conn, `
    SELECT SubAccountId as id, SubAccountName as name, SUM(EffectiveCost) as total
    FROM ${src}
    GROUP BY SubAccountId, SubAccountName ORDER BY total DESC LIMIT 15
  `);
  const accountTotal = accountRows.reduce((s, r) => s + Number(r['total']), 0);
  const accounts = accountRows.map(r => ({
    id: String(r['id']),
    name: String(r['name']),
    costShare: Number(r['total']) / accountTotal,
  }));

  const regionRows = await queryAll(conn, `SELECT DISTINCT RegionId as r FROM ${src} WHERE RegionId IS NOT NULL AND RegionId != '' ORDER BY r`);
  const regions = regionRows.map(r => String(r['r']));

  const tagDefs = await loadTagDefs();
  const tagResults: Record<string, { values: string[]; missingPercent: number }> = {};
  for (const tag of tagDefs) {
    // FOCUS Tags map keys are the raw tag keys — no CUR-style user_ prefix.
    // Escaped for SQL-literal position: tagName comes from the (shareable)
    // dimensions.yaml config, so it is untrusted — same rule as builder.ts.
    const tagKey = tag.tagName.replaceAll("'", "''");
    const concept = tag.concept ?? tag.tagName;
    const valRows = await queryAll(conn, `SELECT DISTINCT element_at(Tags, '${tagKey}')[1] as v FROM ${src} WHERE element_at(Tags, '${tagKey}') IS NOT NULL LIMIT 30`);
    const values = valRows.map(r => String(r['v'])).filter(v => v !== '' && v !== 'null');
    const [missingRow] = await queryAll(conn, `SELECT COUNT(*) as cnt FROM ${src} WHERE element_at(Tags, '${tagKey}') IS NULL`);
    const missingPct = Number(missingRow?.['cnt'] ?? 0) / rowCount;
    tagResults[concept] = { values, missingPercent: missingPct };
  }

  const [pRow] = await queryAll(conn, `SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EffectiveCost) as p50,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EffectiveCost) as p90,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EffectiveCost) as p99
    FROM ${src} WHERE EffectiveCost > 0`);

  const ccRows = await queryAll(conn, `
    SELECT ChargeCategory as t, COUNT(*)::DOUBLE / ${String(rowCount)} as pct
    FROM ${src} GROUP BY ChargeCategory`);
  const chargeCategories: Record<string, number> = {};
  for (const r of ccRows) chargeCategories[String(r['t'])] = Number(r['pct']);

  const profileData: Profile = {
    rowCount,
    dateRange: {
      min: typeof dateRow?.['mn'] === 'string' ? dateRow['mn'] : '',
      max: typeof dateRow?.['mx'] === 'string' ? dateRow['mx'] : '',
    },
    services,
    accounts,
    regions,
    tags: tagResults,
    costDistribution: {
      p50: Number(pRow?.['p50'] ?? 0),
      p90: Number(pRow?.['p90'] ?? 0),
      p99: Number(pRow?.['p99'] ?? 0),
    },
    chargeCategories,
  };

  await writeFile(PROFILE_PATH, JSON.stringify(profileData, null, 2));
  process.stdout.write(`Profile written to ${PROFILE_PATH}\n`);
  process.stdout.write(`  ${String(rowCount)} rows, ${String(services.length)} services, ${String(accounts.length)} accounts\n`);
  const tagSummary = Object.entries(tagResults).map(([k, v]) => `${String(v.values.length)} ${k}`).join(', ');
  process.stdout.write(`  ${tagSummary}\n`);
}

function generateDailyDates(): string[] {
  const dates: string[] = [];
  for (let m = 1; m <= 2; m++) {
    const daysInMonth = m === 1 ? 31 : 28;
    for (let d = 1; d <= daysInMonth; d++) {
      dates.push(`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return dates;
}

async function generate(): Promise<void> {
  process.stdout.write('Generating synthetic fixtures...\n');

  let profileData: Profile;
  try {
    const content = await import(`file://${PROFILE_PATH}`, { with: { type: 'json' } });
    profileData = content.default as Profile;
  } catch {
    process.stdout.write('No profile.json found, using default profile.\n');
    profileData = DEFAULT_PROFILE;
  }

  const rand = seededRandom(42);
  const db = await DuckDBInstance.create();
  const conn = await db.connect();

  const accountNames = [
    'Acme Corp Main', 'Payments Production', 'Cards Production',
    'Identity Production', 'Platform Engineering', 'Security Operations',
    'Data Analytics Production', 'CI/CD Platform', 'Networking',
    'Billing Production', 'Staging Shared', 'Development Sandbox',
    'Disaster Recovery', 'Monitoring', 'Logging',
  ];
  const syntheticAccounts = profileData.accounts.map((a, i) => ({
    id: String(100000000000 + i),
    name: accountNames[i] ?? `Account-${String(i)}`,
    costShare: a.costShare,
  }));

  const cfg: FocusFixtureConfig = {
    services: profileData.services.map(s => ({ code: s.code, costShare: s.costShare, name: s.name })),
    accounts: syntheticAccounts,
    regions: profileData.regions.slice(0, 5),
    owners: [
      'backend', 'frontend', 'platform', 'data-eng', 'security',
      'payments', 'identity', 'cards', 'sre', 'devops', 'ml', 'mobile',
    ],
    products: [
      'api-gateway', 'auth-service', 'billing-engine', 'card-processor',
      'data-pipeline', 'event-bus', 'identity-provider', 'ledger',
      'notification-service', 'payment-router', 'risk-engine',
      'search-index', 'user-service', 'vault', 'workflow-engine',
    ],
    envs: ['production', 'staging', 'testing', 'sandbox'],
  };

  const dailyDates = generateDailyDates();
  const rowCount = await buildSyntheticTable(conn, dailyDates, cfg, rand);
  process.stdout.write(`  Generated ${String(rowCount)} rows\n`);

  // Export daily data as raw monthly files
  const rawDir = join(SYNTHETIC_DIR, FIXTURE_PROVIDER_NAME, 'raw');
  const months = [...new Set(dailyDates.map(d => d.slice(0, 7)))];
  for (const month of months) {
    const monthDir = join(rawDir, `daily-${month}`);
    await mkdir(monthDir, { recursive: true });
    const outPath = join(monthDir, 'data.parquet');
    await conn.run(`COPY (SELECT * FROM synthetic WHERE ChargePeriodStart::DATE::VARCHAR LIKE '${month}%') TO '${outPath}' (FORMAT PARQUET)`);
  }
  process.stdout.write(`  Exported ${String(months.length)} monthly raw files\n`);

  // The second provider, for the mixed-workspace e2e. Written here as well as
  // in the vitest global setup because CI generates fixtures through THIS
  // script before the e2e shards — adding it to only one generator leaves it
  // present locally and missing in CI.
  await writeGcpProvider(conn, SYNTHETIC_DIR, months);
  process.stdout.write(`  Exported ${String(months.length)} GCP monthly raw files\n`);

  // Export hourly data (last 7 days of Feb expanded to hourly charge periods).
  // Month-span rows (Purchase/Tax/Credit) are kept as-is — real hourly FOCUS
  // exports also deliver monthly-frequency charges as month-span rows.
  const hourlyMonthDir = join(rawDir, 'hourly-2026-02');
  await mkdir(hourlyMonthDir, { recursive: true });
  const hourlyDates = dailyDates.slice(-7);
  await conn.run(`
    CREATE TABLE hourly_synthetic AS
    SELECT
      ChargePeriodStart + INTERVAL (h) HOUR AS ChargePeriodStart,
      ChargePeriodStart + INTERVAL (h + 1) HOUR AS ChargePeriodEnd,
      BillingPeriodStart,
      BillingAccountId, SubAccountId, SubAccountName,
      RegionId, RegionName, ServiceName, ServiceCategory, ChargeDescription,
      ChargeCategory, ChargeClass, PricingCategory,
      CommitmentDiscountId, CommitmentDiscountName, CommitmentDiscountStatus, CommitmentDiscountType,
      ConsumedQuantity / 24.0 AS ConsumedQuantity,
      ConsumedUnit, ResourceId, ResourceName, ResourceType,
      BilledCost / 24.0 AS BilledCost,
      EffectiveCost / 24.0 AS EffectiveCost,
      ListCost / 24.0 AS ListCost,
      ContractedCost / 24.0 AS ContractedCost,
      PublisherName, InvoiceIssuerName, SkuMeter, Tags, x_Operation, x_ServiceCode,
      ProviderName, BillingCurrency
    FROM synthetic
    CROSS JOIN generate_series(0, 23) AS t(h)
    WHERE ChargePeriodStart::DATE::VARCHAR IN (${hourlyDates.map(d => `'${d}'`).join(', ')})
      AND ChargeCategory = 'Usage'
  `);
  // Month-span rows (Purchase/Tax/Credit) ride along unexpanded — real hourly
  // FOCUS exports deliver monthly-frequency charges as month-span rows too.
  await conn.run(`
    INSERT INTO hourly_synthetic
    SELECT * FROM synthetic
    WHERE ChargeCategory != 'Usage'
      AND ChargePeriodStart::DATE::VARCHAR LIKE '2026-02%'
  `);
  await conn.run(`
    COPY (
      SELECT * FROM hourly_synthetic
    ) TO '${join(hourlyMonthDir, 'data.parquet')}' (FORMAT PARQUET)
  `);
  process.stdout.write(`  Exported hourly raw file (${String(hourlyDates.length)} days)\n`);

  process.stdout.write('Done!\n');
}

const args = new Set(process.argv.slice(2));
if (args.has('--profile')) {
  await profile();
} else if (args.has('--generate')) {
  await generate();
} else {
  process.stdout.write('Usage: npx tsx generate.ts --profile | --generate\n');
}
