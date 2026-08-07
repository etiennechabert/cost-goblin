import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, access, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_GCP_PROVIDER_NAME, FIXTURE_PROVIDER_NAME } from './layout.js';
import { buildSyntheticTable, pick, seededRandom, weightedPick } from './focus-fixture.js';
import type { FocusFixtureConfig } from './focus-fixture.js';
import { canonicalizeGcpPeriod } from '../sync/gcp-canonicalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, 'synthetic');
const MARKER = join(SYNTHETIC_DIR, '.generated');

type FixtureConfig = FocusFixtureConfig;

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

interface ActionType {
  action: string;
  resourceType: string;
  service: string;
  efforts: readonly string[];
}

const INSTANCE_TYPES = ['t3.micro', 't3.small', 't3.medium', 'm5.large', 'm5.xlarge', 'r5.large', 'r5.xlarge', 'c5.large', 'c5.xlarge'];
const RDS_TYPES = ['db.t3.micro', 'db.t3.small', 'db.t4g.medium', 'db.r5.large', 'db.r5.xlarge'];

function generateRecSummaries(at: ActionType, region: string, rand: () => number): { summary: string; currentSummary: string; currentDetails: string; recommendedDetails: string } {
  if (at.action === 'Rightsize' && at.resourceType === 'Ec2Instance') {
    const curr = pick(INSTANCE_TYPES, rand);
    const rec = pick(INSTANCE_TYPES, rand);
    return {
      currentSummary: `${curr} in ${region}`,
      summary: `${rec} in ${region}`,
      currentDetails: `{"instanceType": "${curr}", "vcpus": "2", "memory": "8 GiB"}`,
      recommendedDetails: `{"instanceType": "${rec}", "vcpus": "2", "memory": "4 GiB"}`,
    };
  }
  if (at.resourceType === 'RdsDbInstance' || at.resourceType === 'RdsReservedInstances') {
    const curr = pick(RDS_TYPES, rand);
    const rec = pick(RDS_TYPES, rand);
    return {
      currentSummary: `${curr} MySQL in ${region}`,
      summary: at.action === 'PurchaseReservedInstances' ? `${String(Math.floor(rand() * 5 + 1))} ${curr} MySQL in ${region}` : `${rec} MySQL in ${region}`,
      currentDetails: `{"instanceType": "${curr}", "engine": "MySQL", "multiAZ": "false"}`,
      recommendedDetails: `{"instanceType": "${rec}", "engine": "MySQL"}`,
    };
  }
  if (at.action === 'Delete') {
    return {
      currentSummary: `Unused ${at.resourceType} in ${region}`,
      summary: `Delete unused ${at.resourceType}`,
      currentDetails: '',
      recommendedDetails: '',
    };
  }
  return { summary: `${at.resourceType} in ${region}`, currentSummary: '', currentDetails: '', recommendedDetails: '' };
}

function generateCostOptRows(actionTypes: readonly ActionType[], cfg: FixtureConfig, rand: () => number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < 25; i++) {
    const at = pick(actionTypes, rand);
    const account = weightedPick(cfg.accounts, rand);
    const region = pick(cfg.regions, rand);
    const effort = pick(at.efforts, rand);
    const monthlyCost = Math.round((rand() * 4000 + 100) * 100) / 100;
    const savingsPct = Math.round((rand() * 60 + 10) * 100) / 100;
    const monthlySavings = Math.round(monthlyCost * savingsPct / 100 * 100) / 100;
    const recId = `rec-${String(i).padStart(4, '0')}`;
    const arn = `arn:aws:${at.service}:${region}:${account.id}:${at.resourceType.toLowerCase()}/${String(Math.floor(rand() * 10000))}`;

    const { summary, currentSummary, currentDetails, recommendedDetails } = generateRecSummaries(at, region, rand);

    const source = rand() < 0.6 ? 'ComputeOptimizer' : 'CostExplorer';
    const restart = at.action === 'Rightsize' ? (rand() < 0.4) : false;
    const rollback = at.action !== 'Delete';

    rows.push(`('${recId}', '${account.id}', '${account.name}', '${at.action}', '${at.resourceType}', '${summary.replaceAll("'", "''")}', '${region}', ${String(monthlySavings)}, ${String(monthlyCost)}, ${String(savingsPct)}, '${effort}', '${arn}', '${currentDetails.replaceAll("'", "''")}', '${recommendedDetails.replaceAll("'", "''")}', '${currentSummary.replaceAll("'", "''")}', ${String(restart)}, ${String(rollback)}, '${source}')`);
  }
  return rows;
}

/**
 * Write the second provider's tree, in the shape a real GCP sync leaves
 * behind: BigQuery's delivered Parquet put through the actual canonicalizer.
 *
 * Deriving it from the `synthetic` table rather than generating fresh rows is
 * deliberate — the two providers then share accounts and tag values, so a
 * mixed-workspace query has something to get WRONG. Only the shape is
 * GCP-specific: tz-aware timestamps, DECIMAL costs, repeated-struct tags,
 * `x_ServiceId`/`SkuId`, and no ServiceCategory / CommitmentDiscountStatus /
 * x_ServiceCode / x_Operation / SkuMeter at all.
 */
async function writeGcpProvider(
  conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>,
  months: readonly string[],
): Promise<void> {
  // GCP names its services differently, and SubAccountId is a project.
  await conn.run(`
    CREATE TABLE gcp_bq AS SELECT
      ChargePeriodStart AT TIME ZONE 'UTC' AS ChargePeriodStart,
      -- A GCP project, derived from the AWS account so the two providers stay
      -- correlated without pretending to share an account namespace.
      'proj-' || right(SubAccountId, 3) AS SubAccountId,
      SubAccountName,
      CAST(BilledCost AS DECIMAL(38,9)) AS BilledCost,
      CAST(EffectiveCost AS DECIMAL(38,9)) AS EffectiveCost,
      CAST(ListCost AS DECIMAL(38,9)) AS ListCost,
      CAST(ContractedCost AS DECIMAL(38,9)) AS ContractedCost,
      -- Switched on x_ServiceCode, not ServiceName: the latter is the display
      -- name ("Amazon Elastic Compute Cloud"), so matching on it silently
      -- collapsed every row into the ELSE branch.
      CASE x_ServiceCode
        WHEN 'AmazonEC2' THEN 'Compute Engine'
        WHEN 'AmazonRDS' THEN 'Cloud SQL'
        WHEN 'AmazonS3' THEN 'Cloud Storage'
        WHEN 'AWSLambda' THEN 'Cloud Run Functions'
        WHEN 'AmazonDynamoDB' THEN 'Firestore'
        WHEN 'AmazonVPC' THEN 'Networking'
        WHEN 'AmazonCloudWatch' THEN 'Cloud Monitoring'
        ELSE 'Cloud Logging'
      END AS ServiceName,
      'europe-west1' AS RegionId,
      ResourceId,
      ChargeCategory,
      PricingCategory,
      ChargeDescription,
      CAST(ConsumedQuantity AS DECIMAL(38,9)) AS ConsumedQuantity,
      list_transform(map_entries(Tags), e -> struct_pack(
        "Key" := e.key, "Value" := e.value, x_Inherited := false)) AS x_Tags,
      CAST([] AS STRUCT("Key" VARCHAR, "Value" VARCHAR)[]) AS x_Labels,
      'compute.googleapis.com' AS x_ServiceId,
      SkuMeter AS SkuId,
      TIMESTAMPTZ '2026-03-01 04:00:00+00' AS x_ExportTime
    FROM synthetic`);

  for (const month of months) {
    const staging = join(SYNTHETIC_DIR, '.gcp-staging', month);
    await mkdir(staging, { recursive: true });
    await conn.run(`COPY (SELECT * FROM gcp_bq WHERE ChargePeriodStart::DATE::VARCHAR LIKE '${month}%')
      TO '${join(staging, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);

    const outDir = join(SYNTHETIC_DIR, FIXTURE_GCP_PROVIDER_NAME, 'raw', `daily-${month}`);
    await mkdir(outDir, { recursive: true });
    await canonicalizeGcpPeriod({
      stagingDir: staging,
      outputPath: join(outDir, 'part-0.parquet'),
      connection: conn,
    });
  }
  await rm(join(SYNTHETIC_DIR, '.gcp-staging'), { recursive: true, force: true });
}

export async function setup(): Promise<void> {
  const dailyParquet = join(SYNTHETIC_DIR, FIXTURE_PROVIDER_NAME, 'raw', 'daily-2026-01', 'data.parquet');
  const gcpParquet = join(SYNTHETIC_DIR, FIXTURE_GCP_PROVIDER_NAME, 'raw', 'daily-2026-01', 'part-0.parquet');
  try {
    // Both are checked: a tree generated before the GCP provider existed is
    // still on developers' disks, and returning early on the AWS file alone
    // would leave the mixed-workspace fixture permanently missing.
    await access(dailyParquet);
    await access(gcpParquet);
    return;
  } catch {
    // needs generation
  }

  const rand = seededRandom(42);
  const db = await DuckDBInstance.create();
  const conn = await db.connect();

  const cfg: FixtureConfig = {
    services: [
      { code: 'AmazonEC2', costShare: 0.25 },
      { code: 'AmazonRDS', costShare: 0.2 },
      { code: 'AmazonS3', costShare: 0.1 },
      { code: 'AWSLambda', costShare: 0.08 },
      { code: 'AmazonCloudWatch', costShare: 0.07 },
      { code: 'AmazonDynamoDB', costShare: 0.06 },
      { code: 'AmazonVPC', costShare: 0.05 },
      { code: 'AWSBackup', costShare: 0.05 },
      { code: 'AmazonECR', costShare: 0.04 },
      { code: 'AmazonSNS', costShare: 0.03 },
      { code: 'AmazonSQS', costShare: 0.02 },
      { code: 'AWSCloudTrail', costShare: 0.02 },
      { code: 'AmazonRoute53', costShare: 0.015 },
      { code: 'AmazonEFS', costShare: 0.015 },
    ],
    accounts: [
      { id: '100000000000', name: 'Acme Corp Main', costShare: 0.3 },
      { id: '100000000001', name: 'Payments Production', costShare: 0.2 },
      { id: '100000000002', name: 'Cards Production', costShare: 0.15 },
      { id: '100000000003', name: 'Identity Production', costShare: 0.1 },
      { id: '100000000004', name: 'Platform Engineering', costShare: 0.08 },
      { id: '100000000005', name: 'Security Operations', costShare: 0.07 },
      { id: '100000000006', name: 'Data Analytics', costShare: 0.05 },
      { id: '100000000007', name: 'CI/CD Platform', costShare: 0.05 },
    ],
    regions: ['eu-central-1', 'us-east-1', 'eu-west-1', 'us-west-2', 'ap-southeast-1'],
    owners: ['backend', 'frontend', 'platform', 'data-eng', 'security', 'payments', 'identity', 'sre'],
    products: ['api-gateway', 'auth-service', 'billing-engine', 'data-pipeline', 'event-bus', 'ledger'],
    envs: ['production', 'staging', 'testing', 'sandbox'],
  };

  const dailyDates = generateDailyDates();

  await buildSyntheticTable(conn, dailyDates, cfg, rand);

  const rawDir = join(SYNTHETIC_DIR, FIXTURE_PROVIDER_NAME, 'raw');
  const months = [...new Set(dailyDates.map(d => d.slice(0, 7)))];
  for (const month of months) {
    const monthDir = join(rawDir, `daily-${month}`);
    await mkdir(monthDir, { recursive: true });
    await conn.run(`COPY (SELECT * FROM synthetic WHERE ChargePeriodStart::DATE::VARCHAR LIKE '${month}%') TO '${join(monthDir, 'data.parquet')}' (FORMAT PARQUET)`);
  }

  await writeGcpProvider(conn, months);

  const hourlyDir = join(rawDir, 'hourly-2026-02');
  await mkdir(hourlyDir, { recursive: true });
  const hourlyDates = dailyDates.slice(-7);
  const hourlyWhere = hourlyDates.map(d => `ChargePeriodStart::DATE = '${d}'`).join(' OR ');
  await conn.run(`COPY (SELECT * FROM synthetic WHERE ${hourlyWhere}) TO '${join(hourlyDir, 'data.parquet')}' (FORMAT PARQUET)`);

  // --- Cost optimization recommendations ---
  const costOptDir = join(rawDir, 'cost-opt-2026-02');
  await mkdir(costOptDir, { recursive: true });

  const actionTypes = [
    { action: 'Rightsize', resourceType: 'Ec2Instance', service: 'ec2', efforts: ['Low', 'Medium'] as const },
    { action: 'PurchaseReservedInstances', resourceType: 'RdsReservedInstances', service: 'rds', efforts: ['VeryLow'] as const },
    { action: 'PurchaseSavingsPlans', resourceType: 'ComputeSavingsPlans', service: 'ec2', efforts: ['VeryLow'] as const },
    { action: 'Delete', resourceType: 'EbsVolume', service: 'ebs', efforts: ['Low'] as const },
    { action: 'Delete', resourceType: 'ElasticIpAddress', service: 'ec2', efforts: ['Low'] as const },
    { action: 'Rightsize', resourceType: 'RdsDbInstance', service: 'rds', efforts: ['Medium', 'High'] as const },
  ];

  const costOptRows = generateCostOptRows(actionTypes, cfg, rand);

  await conn.run(`
    CREATE TABLE cost_opt (
      recommendation_id VARCHAR,
      account_id VARCHAR,
      account_name VARCHAR,
      action_type VARCHAR,
      current_resource_type VARCHAR,
      recommended_resource_summary VARCHAR,
      region VARCHAR,
      estimated_monthly_savings_after_discount DOUBLE,
      estimated_monthly_cost_after_discount DOUBLE,
      estimated_savings_percentage_after_discount DOUBLE,
      implementation_effort VARCHAR,
      resource_arn VARCHAR,
      current_resource_details VARCHAR,
      recommended_resource_details VARCHAR,
      current_resource_summary VARCHAR,
      restart_needed BOOLEAN,
      rollback_possible BOOLEAN,
      recommendation_source VARCHAR
    )
  `);
  await conn.run(`INSERT INTO cost_opt VALUES ${costOptRows.join(',')}`);
  await conn.run(`COPY (SELECT * FROM cost_opt) TO '${join(costOptDir, 'data.parquet')}' (FORMAT PARQUET)`);

  await writeFile(MARKER, new Date().toISOString());
}
