import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, 'synthetic');
const MARKER = join(SYNTHETIC_DIR, '.generated');

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function pick<T>(arr: readonly T[], rand: () => number): T {
  const idx = Math.floor(rand() * arr.length);
  const item = arr[idx];
  if (item === undefined) throw new Error(`pick: empty array`);
  return item;
}

function weightedPick<T extends { costShare: number }>(arr: readonly T[], rand: () => number): T {
  const r = rand();
  let cumulative = 0;
  for (const item of arr) {
    cumulative += item.costShare;
    if (r <= cumulative) return item;
  }
  const last = arr.at(-1);
  if (last === undefined) throw new Error(`weightedPick: empty array`);
  return last;
}

import { SERVICE_META, DEFAULT_META } from './service-meta.js';

interface FixtureConfig {
  services: { name: string; costShare: number }[];
  accounts: { id: string; name: string; costShare: number }[];
  regions: string[];
  owners: string[];
  products: string[];
  envs: string[];
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

function generateFixtureRow(date: string, cfg: FixtureConfig, rand: () => number): string {
  const service = weightedPick(cfg.services, rand);
  const account = weightedPick(cfg.accounts, rand);
  const region = pick(cfg.regions, rand);
  const owner = rand() < 0.08 ? null : pick(cfg.owners, rand);
  const product = rand() < 0.12 ? null : pick(cfg.products, rand);
  const env = rand() < 0.03 ? null : pick(cfg.envs, rand);
  const cost = Math.round(Math.exp(rand() * 6 - 2) * service.costShare * 10 * 100) / 100;
  const listCost = Math.round(cost * (1 + rand() * 0.3) * 100) / 100;
  const usageAmount = Math.round(rand() * 1000 * 100) / 100;
  const resourceId = `arn:aws:${service.name.toLowerCase()}:${region}:${account.id}:resource/${String(Math.floor(rand() * 10000))}`;

  const meta = SERVICE_META[service.name] ?? DEFAULT_META;
  const operation = pick(meta.operations, rand);

  const tagEntries: string[] = [];
  if (owner !== null) tagEntries.push(`'user_team': '${owner}'`);
  if (product !== null) tagEntries.push(`'user_system': '${product}'`);
  if (env !== null) tagEntries.push(`'user_environment': '${env}'`);

  const netCost = Math.round(cost * 0.97 * 100) / 100;
  return `(TIMESTAMP '${date}', '${account.id}', '${account.name}', '${region}', '${service.name}', '${meta.family}', '${operation}', '${resourceId}', ${String(usageAmount)}, ${String(cost)}, ${String(cost)}, ${String(netCost)}, ${String(listCost)}, NULL, NULL, NULL, NULL, 'Usage', '${operation}', 'Usage', MAP {${tagEntries.join(', ')}})`;
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

export async function setup(): Promise<void> {
  const dailyParquet = join(SYNTHETIC_DIR, 'aws', 'raw', 'daily-2026-01', 'data.parquet');
  try {
    await access(dailyParquet);
    return;
  } catch {
    // needs generation
  }

  const rand = seededRandom(42);
  const db = await DuckDBInstance.create();
  const conn = await db.connect();

  const cfg: FixtureConfig = {
    services: [
      { name: 'AmazonEC2', costShare: 0.25 },
      { name: 'AmazonRDS', costShare: 0.2 },
      { name: 'AmazonS3', costShare: 0.1 },
      { name: 'AWSLambda', costShare: 0.08 },
      { name: 'AmazonCloudWatch', costShare: 0.07 },
      { name: 'AmazonDynamoDB', costShare: 0.06 },
      { name: 'AmazonVPC', costShare: 0.05 },
      { name: 'AWSBackup', costShare: 0.05 },
      { name: 'AmazonECR', costShare: 0.04 },
      { name: 'AmazonSNS', costShare: 0.03 },
      { name: 'AmazonSQS', costShare: 0.02 },
      { name: 'AWSCloudTrail', costShare: 0.02 },
      { name: 'AmazonRoute53', costShare: 0.015 },
      { name: 'AmazonEFS', costShare: 0.015 },
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

  const rows: string[] = [];
  for (const date of dailyDates) {
    for (let i = 0; i < 50; i++) {
      rows.push(generateFixtureRow(date, cfg, rand));
    }
  }

  await conn.run(`
    CREATE TABLE synthetic (
      line_item_usage_start_date TIMESTAMP,
      line_item_usage_account_id VARCHAR,
      line_item_usage_account_name VARCHAR,
      product_region_code VARCHAR,
      product_servicecode VARCHAR,
      product_product_family VARCHAR,
      line_item_line_item_description VARCHAR,
      line_item_resource_id VARCHAR,
      line_item_usage_amount DOUBLE,
      line_item_unblended_cost DOUBLE,
      line_item_blended_cost DOUBLE,
      line_item_net_unblended_cost DOUBLE,
      pricing_public_on_demand_cost DOUBLE,
      reservation_effective_cost DOUBLE,
      reservation_net_effective_cost DOUBLE,
      savings_plan_savings_plan_effective_cost DOUBLE,
      savings_plan_net_savings_plan_effective_cost DOUBLE,
      line_item_line_item_type VARCHAR,
      line_item_operation VARCHAR,
      line_item_usage_type VARCHAR,
      resource_tags MAP(VARCHAR, VARCHAR)
    )
  `);

  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await conn.run(`INSERT INTO synthetic VALUES ${batch.join(',')}`);
  }

  const rawDir = join(SYNTHETIC_DIR, 'aws', 'raw');
  const months = [...new Set(dailyDates.map(d => d.slice(0, 7)))];
  for (const month of months) {
    const monthDir = join(rawDir, `daily-${month}`);
    await mkdir(monthDir, { recursive: true });
    await conn.run(`COPY (SELECT * FROM synthetic WHERE line_item_usage_start_date::DATE::VARCHAR LIKE '${month}%') TO '${join(monthDir, 'data.parquet')}' (FORMAT PARQUET)`);
  }

  const hourlyDir = join(rawDir, 'hourly-2026-02');
  await mkdir(hourlyDir, { recursive: true });
  const hourlyDates = dailyDates.slice(-7);
  const hourlyWhere = hourlyDates.map(d => `line_item_usage_start_date::DATE = '${d}'`).join(' OR ');
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
