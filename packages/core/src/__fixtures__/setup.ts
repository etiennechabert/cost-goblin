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
  const last = arr[arr.length - 1];
  if (last === undefined) throw new Error(`weightedPick: empty array`);
  return last;
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

  const services = [
    { name: 'AmazonEC2', costShare: 0.25 },
    { name: 'AmazonRDS', costShare: 0.20 },
    { name: 'AmazonS3', costShare: 0.10 },
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
  ];

  const accounts = [
    { id: '100000000000', name: 'Acme Corp Main', costShare: 0.3 },
    { id: '100000000001', name: 'Payments Production', costShare: 0.2 },
    { id: '100000000002', name: 'Cards Production', costShare: 0.15 },
    { id: '100000000003', name: 'Identity Production', costShare: 0.1 },
    { id: '100000000004', name: 'Platform Engineering', costShare: 0.08 },
    { id: '100000000005', name: 'Security Operations', costShare: 0.07 },
    { id: '100000000006', name: 'Data Analytics', costShare: 0.05 },
    { id: '100000000007', name: 'CI/CD Platform', costShare: 0.05 },
  ];

  const regions = ['eu-central-1', 'us-east-1', 'eu-west-1', 'us-west-2', 'ap-southeast-1'];
  const owners = ['backend', 'frontend', 'platform', 'data-eng', 'security', 'payments', 'identity', 'sre'];
  const products = ['api-gateway', 'auth-service', 'billing-engine', 'data-pipeline', 'event-bus', 'ledger'];
  const envs = ['production', 'staging', 'testing', 'sandbox'];

  const dailyDates: string[] = [];
  for (let m = 1; m <= 2; m++) {
    const daysInMonth = m === 1 ? 31 : 28;
    for (let d = 1; d <= daysInMonth; d++) {
      dailyDates.push(`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }

  const rows: string[] = [];
  for (const date of dailyDates) {
    for (let i = 0; i < 50; i++) {
      const service = weightedPick(services, rand);
      const account = weightedPick(accounts, rand);
      const region = pick(regions, rand);
      const owner = rand() < 0.08 ? null : pick(owners, rand);
      const product = rand() < 0.12 ? null : pick(products, rand);
      const env = rand() < 0.03 ? null : pick(envs, rand);
      const cost = Math.round(Math.exp(rand() * 6 - 2) * service.costShare * 10 * 100) / 100;
      const listCost = Math.round(cost * (1 + rand() * 0.3) * 100) / 100;
      const usageAmount = Math.round(rand() * 1000 * 100) / 100;
      const resourceId = `arn:aws:${service.name.toLowerCase()}:${region}:${account.id}:resource/${String(Math.floor(rand() * 10000))}`;

      const tagEntries: string[] = [];
      if (owner !== null) tagEntries.push(`'user_team': '${owner}'`);
      if (product !== null) tagEntries.push(`'user_system': '${product}'`);
      if (env !== null) tagEntries.push(`'user_environment': '${env}'`);

      // Synthetic fixture: blended = unblended (no consolidated-billing
      // variance), RI/SP effective cost NULL so amortized falls through to
      // unblended via COALESCE. Real CUR has these columns populated for
      // rows covered by an RI or SP.
      rows.push(`(TIMESTAMP '${date}', '${account.id}', '${account.name}', '${region}', '${service.name}', 'Compute', 'Usage', '${resourceId}', ${String(usageAmount)}, ${String(cost)}, ${String(cost)}, ${String(listCost)}, NULL, NULL, 'Usage', 'RunInstances', 'Usage', MAP {${tagEntries.join(', ')}})`);
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
      pricing_public_on_demand_cost DOUBLE,
      reservation_effective_cost DOUBLE,
      savings_plan_savings_plan_effective_cost DOUBLE,
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

  await writeFile(MARKER, new Date().toISOString());
}
