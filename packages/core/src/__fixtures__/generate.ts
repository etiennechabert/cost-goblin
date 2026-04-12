import { DuckDBInstance } from '@duckdb/node-api';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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
  services: { name: string; costShare: number; avgDailyCost: number }[];
  accounts: { id: string; name: string; costShare: number }[];
  regions: string[];
  tags: Record<string, { values: string[]; missingPercent: number }>;
  costDistribution: { p50: number; p90: number; p99: number };
  lineItemTypes: Record<string, number>;
}

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

async function profile(): Promise<void> {
  process.stdout.write('Profiling real data...\n');
  const db = await DuckDBInstance.create();
  const conn = await db.connect();
  const src = `read_parquet('${RAW_DATA}/BILLING_PERIOD=*/*.parquet')`;

  const [countRow] = await queryAll(conn, `SELECT COUNT(*) as cnt FROM ${src}`);
  const rowCount = Number(countRow?.['cnt'] ?? 0);

  const [dateRow] = await queryAll(conn, `SELECT MIN(line_item_usage_start_date)::DATE::VARCHAR as mn, MAX(line_item_usage_end_date)::DATE::VARCHAR as mx FROM ${src}`);

  const totalCostRows = await queryAll(conn, `SELECT SUM(line_item_unblended_cost) as total FROM ${src}`);
  const totalCost = Number(totalCostRows[0]?.['total'] ?? 1);
  const days = 30;

  const serviceRows = await queryAll(conn, `
    SELECT product_servicecode as name, SUM(line_item_unblended_cost) as total
    FROM ${src}
    WHERE product_servicecode IS NOT NULL AND product_servicecode != ''
    GROUP BY product_servicecode ORDER BY total DESC LIMIT 20
  `);
  const services = serviceRows.map(r => ({
    name: String(r['name']),
    costShare: Number(r['total']) / totalCost,
    avgDailyCost: Number(r['total']) / days,
  }));

  const accountRows = await queryAll(conn, `
    SELECT line_item_usage_account_id as id, line_item_usage_account_name as name, SUM(line_item_unblended_cost) as total
    FROM ${src}
    GROUP BY line_item_usage_account_id, line_item_usage_account_name ORDER BY total DESC LIMIT 15
  `);
  const accountTotal = accountRows.reduce((s, r) => s + Number(r['total']), 0);
  const accounts = accountRows.map(r => ({
    id: String(r['id']),
    name: String(r['name']),
    costShare: Number(r['total']) / accountTotal,
  }));

  const regionRows = await queryAll(conn, `SELECT DISTINCT product_region_code as r FROM ${src} WHERE product_region_code IS NOT NULL ORDER BY r`);
  const regions = regionRows.map(r => String(r['r']));

  const tagDefs = await loadTagDefs();
  const tagResults: Record<string, { values: string[]; missingPercent: number }> = {};
  for (const tag of tagDefs) {
    const curKey = `user_${tag.tagName}`;
    const concept = tag.concept ?? tag.tagName;
    const valRows = await queryAll(conn, `SELECT DISTINCT element_at(resource_tags, '${curKey}')[1] as v FROM ${src} WHERE element_at(resource_tags, '${curKey}') IS NOT NULL LIMIT 30`);
    const values = valRows.map(r => String(r['v'])).filter(v => v !== '' && v !== 'null');
    const [missingRow] = await queryAll(conn, `SELECT COUNT(*) as cnt FROM ${src} WHERE element_at(resource_tags, '${curKey}') IS NULL`);
    const missingPct = Number(missingRow?.['cnt'] ?? 0) / rowCount;
    tagResults[concept] = { values, missingPercent: missingPct };
  }

  const [pRow] = await queryAll(conn, `SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY line_item_unblended_cost) as p50,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY line_item_unblended_cost) as p90,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY line_item_unblended_cost) as p99
    FROM ${src} WHERE line_item_unblended_cost > 0`);

  const litRows = await queryAll(conn, `
    SELECT line_item_line_item_type as t, COUNT(*)::DOUBLE / ${String(rowCount)} as pct
    FROM ${src} GROUP BY line_item_line_item_type`);
  const lineItemTypes: Record<string, number> = {};
  for (const r of litRows) lineItemTypes[String(r['t'])] = Number(r['pct']);

  const profileData: Profile = {
    rowCount,
    dateRange: { min: String(dateRow?.['mn'] ?? ''), max: String(dateRow?.['mx'] ?? '') },
    services,
    accounts,
    regions,
    tags: tagResults,
    costDistribution: {
      p50: Number(pRow?.['p50'] ?? 0),
      p90: Number(pRow?.['p90'] ?? 0),
      p99: Number(pRow?.['p99'] ?? 0),
    },
    lineItemTypes,
  };

  await writeFile(PROFILE_PATH, JSON.stringify(profileData, null, 2));
  process.stdout.write(`Profile written to ${PROFILE_PATH}\n`);
  process.stdout.write(`  ${String(rowCount)} rows, ${String(services.length)} services, ${String(accounts.length)} accounts\n`);
  const tagSummary = Object.entries(tagResults).map(([k, v]) => `${String(v.values.length)} ${k}`).join(', ');
  process.stdout.write(`  ${tagSummary}\n`);
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function pick<T>(arr: readonly T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

function weightedPick<T extends { costShare: number }>(arr: readonly T[], rand: () => number): T {
  const r = rand();
  let cumulative = 0;
  for (const item of arr) {
    cumulative += item.costShare;
    if (r <= cumulative) return item;
  }
  return arr[arr.length - 1]!;
}

async function generate(): Promise<void> {
  process.stdout.write('Generating synthetic fixtures...\n');

  let profileData: Profile;
  try {
    const content = await import(`file://${PROFILE_PATH}`, { with: { type: 'json' } });
    profileData = content.default as Profile;
  } catch {
    process.stderr.write('No profile.json found. Run with --profile first.\n');
    process.exit(1);
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

  const services = profileData.services;

  const owners = [
    'backend', 'frontend', 'platform', 'data-eng', 'security',
    'payments', 'identity', 'cards', 'sre', 'devops', 'ml', 'mobile',
  ];
  const products = [
    'api-gateway', 'auth-service', 'billing-engine', 'card-processor',
    'data-pipeline', 'event-bus', 'identity-provider', 'ledger',
    'notification-service', 'payment-router', 'risk-engine',
    'search-index', 'user-service', 'vault', 'workflow-engine',
  ];
  const envs = ['production', 'staging', 'testing', 'sandbox'];

  const lineItemTypes = ['Usage', 'Fee', 'Credit', 'Tax'];
  const litWeights = [0.89, 0.06, 0.04, 0.01];

  // Generate daily data: 2 months (Jan + Feb 2026)
  const dailyDates: string[] = [];
  for (let m = 1; m <= 2; m++) {
    const daysInMonth = m === 1 ? 31 : 28;
    for (let d = 1; d <= daysInMonth; d++) {
      dailyDates.push(`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }

  // Generate rows
  const ROWS_PER_DAY = 50;
  const rows: string[] = [];

  for (const date of dailyDates) {
    for (let i = 0; i < ROWS_PER_DAY; i++) {
      const service = weightedPick(services, rand);
      const account = weightedPick(syntheticAccounts, rand);
      const region = pick(profileData.regions.slice(0, 5), rand);

      const ownerMissingRate = Math.max(profileData.tags['owner']?.missingPercent ?? 0.08, 0.08);
      const ownerMissing = rand() < ownerMissingRate;
      const owner = ownerMissing ? null : pick(owners, rand);

      const productMissingRate = Math.max(profileData.tags['product']?.missingPercent ?? 0.12, 0.12);
      const productMissing = rand() < productMissingRate;
      const product = productMissing ? null : pick(products, rand);

      const envMissingRate = Math.max(profileData.tags['environment']?.missingPercent ?? 0.03, 0.03);
      const envMissing = rand() < envMissingRate;
      const env = envMissing ? null : pick(envs, rand);

      // Cost: log-normal distribution roughly matching profile
      const baseCost = Math.exp(rand() * 6 - 2) * service.costShare * 10;
      const cost = Math.round(baseCost * 100) / 100;

      const litR = rand();
      let litCum = 0;
      let lineItemType = 'Usage';
      for (let j = 0; j < lineItemTypes.length; j++) {
        litCum += litWeights[j]!;
        if (litR <= litCum) { lineItemType = lineItemTypes[j]!; break; }
      }

      const listCost = Math.round(cost * (1 + rand() * 0.3) * 100) / 100;
      const usageAmount = Math.round(rand() * 1000 * 100) / 100;
      const resourceId = `arn:aws:${service.name.toLowerCase()}:${region}:${account.id}:resource/${String(Math.floor(rand() * 10000))}`;

      const tagEntries: string[] = [];
      if (owner !== null) tagEntries.push(`'user_team': '${owner}'`);
      if (product !== null) tagEntries.push(`'user_system': '${product}'`);
      if (env !== null) tagEntries.push(`'user_environment': '${env}'`);
      const tagsMap = `MAP {${tagEntries.join(', ')}}`;

      rows.push(`(TIMESTAMP '${date}', '${account.id}', '${account.name}', '${region}', '${service.name}', 'Compute', '${lineItemType}', '${resourceId}', ${String(usageAmount)}, ${String(cost)}, ${String(listCost)}, '${lineItemType}', 'RunInstances', 'Usage', ${tagsMap})`);
    }
  }

  // Create table with raw CUR column names
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
      pricing_public_on_demand_cost DOUBLE,
      line_item_line_item_type VARCHAR,
      line_item_operation VARCHAR,
      line_item_usage_type VARCHAR,
      resource_tags MAP(VARCHAR, VARCHAR)
    )
  `);

  // Insert in batches
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await conn.run(`INSERT INTO synthetic VALUES ${batch.join(',')}`);
  }

  process.stdout.write(`  Generated ${String(rows.length)} rows\n`);

  // Export daily data as raw monthly files
  const rawDir = join(SYNTHETIC_DIR, 'aws', 'raw');
  const months = [...new Set(dailyDates.map(d => d.slice(0, 7)))];
  for (const month of months) {
    const monthDir = join(rawDir, `daily-${month}`);
    await mkdir(monthDir, { recursive: true });
    const outPath = join(monthDir, 'data.parquet');
    await conn.run(`COPY (SELECT * FROM synthetic WHERE line_item_usage_start_date::DATE::VARCHAR LIKE '${month}%') TO '${outPath}' (FORMAT PARQUET)`);
  }
  process.stdout.write(`  Exported ${String(months.length)} monthly raw files\n`);

  // Export hourly data (last 7 days of Feb with hourly timestamps)
  const hourlyMonthDir = join(rawDir, 'hourly-2026-02');
  await mkdir(hourlyMonthDir, { recursive: true });
  const hourlyDates = dailyDates.slice(-7);
  // Expand daily rows into hourly rows by adding hour offsets
  await conn.run(`
    CREATE TABLE hourly_synthetic AS
    SELECT
      line_item_usage_start_date + INTERVAL (h) HOUR AS line_item_usage_start_date,
      line_item_usage_account_id,
      line_item_usage_account_name,
      product_region_code,
      product_servicecode,
      product_product_family,
      line_item_line_item_type,
      line_item_resource_id,
      line_item_usage_amount / 24.0 AS line_item_usage_amount,
      line_item_unblended_cost / 24.0 AS line_item_unblended_cost,
      pricing_public_on_demand_cost / 24.0 AS pricing_public_on_demand_cost,
      line_item_line_item_description,
      line_item_operation,
      line_item_usage_type,
      resource_tags
    FROM synthetic
    CROSS JOIN generate_series(0, 23) AS t(h)
    WHERE line_item_usage_start_date::DATE::VARCHAR IN (${hourlyDates.map(d => `'${d}'`).join(', ')})
  `);
  const hourlyWhereClause = '1=1';
  await conn.run(`
    COPY (
      SELECT * FROM hourly_synthetic WHERE ${hourlyWhereClause}
    ) TO '${join(hourlyMonthDir, 'data.parquet')}' (FORMAT PARQUET)
  `);
  process.stdout.write(`  Exported hourly raw file (${String(hourlyDates.length)} days)\n`);

  process.stdout.write('Done!\n');
}

const args = process.argv.slice(2);
if (args.includes('--profile')) {
  await profile();
} else if (args.includes('--generate')) {
  await generate();
} else {
  process.stdout.write('Usage: npx tsx generate.ts --profile | --generate\n');
}
