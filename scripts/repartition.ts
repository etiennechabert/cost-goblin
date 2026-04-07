import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dirname, '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const OUT_DIR = join(ROOT, 'data', 'processed', 'aws', 'daily');
const DIMENSIONS_PATH = join(ROOT, 'data', 'config', 'dimensions.yaml');

interface TagDimension {
  readonly tagName: string;
  readonly concept?: string | undefined;
}

async function loadTagColumns(): Promise<readonly { key: string; column: string }[]> {
  const raw = await readFile(DIMENSIONS_PATH, 'utf-8');
  const config = parseYaml(raw) as { tags: TagDimension[] };
  return config.tags.map(t => ({
    key: `user_${t.tagName}`,
    column: `tag_${t.concept ?? t.tagName}`,
  }));
}

async function queryAll(conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string): Promise<string[]> {
  const result = await conn.run(sql);
  const rows: string[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const val = chunk.getColumnVector(0).getItem(r);
      if (typeof val === 'string') rows.push(val);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

async function main(): Promise<void> {
  process.stdout.write('Repartitioning raw CUR data to internal schema...\n');

  const entries = await readdir(RAW_DIR, { withFileTypes: true });
  const billingDirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith('BILLING_PERIOD='))
    .map(e => join(RAW_DIR, e.name));

  if (billingDirs.length === 0) {
    process.stderr.write('No BILLING_PERIOD directories found in data/raw/\n');
    process.exit(1);
  }

  process.stdout.write(`Found ${String(billingDirs.length)} billing period(s)\n`);

  const db = await DuckDBInstance.create();
  const conn = await db.connect();

  const tagColumns = await loadTagColumns();
  const tagSelect = tagColumns
    .map(t => `element_at(resource_tags, '${t.key}')[1] AS ${t.column}`)
    .join(',\n      ');

  const allParquets = billingDirs.map(d => `'${d}/*.parquet'`).join(', ');

  // Find all distinct dates
  const dates = await queryAll(conn, `
    SELECT DISTINCT line_item_usage_start_date::DATE::VARCHAR AS d
    FROM read_parquet([${allParquets}])
    ORDER BY d
  `);

  process.stdout.write(`Found ${String(dates.length)} distinct dates\n`);

  let totalRows = 0;

  for (const date of dates) {
    const dateDir = join(OUT_DIR, `usage_date=${date}`);
    await mkdir(dateDir, { recursive: true });
    const outPath = join(dateDir, 'data.parquet');

    const sql = `
      COPY (
        SELECT
          line_item_usage_start_date::DATE AS usage_date,
          line_item_usage_account_id AS account_id,
          line_item_usage_account_name AS account_name,
          COALESCE(product_region_code, '') AS region,
          COALESCE(product_servicecode, '') AS service,
          COALESCE(product_product_family, '') AS service_family,
          COALESCE(line_item_line_item_description, '') AS description,
          COALESCE(line_item_resource_id, '') AS resource_id,
          COALESCE(line_item_usage_amount, 0) AS usage_amount,
          COALESCE(line_item_unblended_cost, 0) AS cost,
          COALESCE(pricing_public_on_demand_cost, 0) AS list_cost,
          COALESCE(line_item_line_item_type, '') AS line_item_type,
          COALESCE(line_item_operation, '') AS operation,
          COALESCE(line_item_usage_type, '') AS usage_type,
          ${tagSelect}
        FROM read_parquet([${allParquets}])
        WHERE line_item_usage_start_date::DATE = '${date}'
      ) TO '${outPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
    `;

    await conn.run(sql);

    const countRows = await queryAll(conn, `SELECT COUNT(*)::VARCHAR FROM read_parquet('${outPath}')`);
    const count = Number(countRows[0] ?? 0);
    totalRows += count;
    process.stdout.write(`  ${date}: ${String(count)} rows\n`);
  }

  process.stdout.write(`\nDone! ${String(totalRows)} total rows across ${String(dates.length)} daily partitions\n`);
  process.stdout.write(`Output: ${OUT_DIR}\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
