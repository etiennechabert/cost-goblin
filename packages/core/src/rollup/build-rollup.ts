import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { logger } from '../logger/logger.js';
import { costExprFor } from '../query/cost-metric.js';
import { rollupDir, rollupParquetPath, upsertRollupEntry, type RollupEntry } from './manifest.js';
import type { RollupSchema } from './schema.js';

function sqlEscapeString(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Build the COPY ... TO ... SQL that materializes one month's rollup parquet.
 *
 * The SELECT mirrors the same column names that buildSource() emits so the
 * rollup file is a drop-in for the inner subquery (read_parquet of the rollup
 * returns rows with the same schema downstream queries already expect — minus
 * the columns we deliberately drop, like resource_id).
 *
 * Group-by keys cover every dimension that could appear in a rollup-eligible
 * GROUP BY at query time. Everything else is a SUM.
 */
export function buildRollupSql(opts: {
  readonly dataDir: string;
  readonly period: string;
  readonly schema: RollupSchema;
  readonly availableColumns: ReadonlySet<string> | undefined;
}): string {
  const { dataDir, period, schema, availableColumns } = opts;

  const has = (col: string): boolean => availableColumns === undefined || availableColumns.has(col);
  // Cost expr resolves to a SQL fragment over raw CUR columns (no table alias
  // needed — the FROM is the parquet glob, no JOINs).
  const costExpr = costExprFor(schema.costMetric, '', schema.costPerspective, availableColumns);

  // Build per-dimension SELECT projections that match buildSource()'s output
  // names. We re-derive these from the raw CUR columns so the rollup parquet
  // schema is independent of buildSource() — no implicit dependency. If a
  // dimension's raw column doesn't exist in this CUR, its projection becomes
  // a NULL literal so the GROUP BY still works.
  const dimSelects: string[] = [];
  for (const field of schema.builtInFields) {
    dimSelects.push(`${rawProjectionFor(field, has)} AS ${field}`);
  }
  for (let i = 0; i < schema.tagColumns.length; i++) {
    const col = schema.tagColumns[i];
    const raw = schema.tagRawKeys[i];
    if (col === undefined || raw === undefined) continue;
    dimSelects.push(`element_at(resource_tags, '${sqlEscapeString(raw)}')[1] AS ${col}`);
  }

  const listExpr = has('pricing_public_on_demand_cost') ? 'COALESCE(pricing_public_on_demand_cost, 0)' : '0';
  const usageExpr = has('line_item_usage_amount') ? 'COALESCE(line_item_usage_amount, 0)' : '0';

  const dimList = schema.builtInFields.length + schema.tagColumns.length;
  const groupByPositions = Array.from({ length: dimList }, (_, i) => String(i + 1)).join(', ');

  const srcGlob = `${dataDir}/aws/raw/daily-${period}/*.parquet`;
  const dest = rollupParquetPath(dataDir, period);

  return `
COPY (
  SELECT
    ${dimSelects.join(',\n    ')},
    SUM(${costExpr}) AS cost,
    SUM(${listExpr}) AS list_cost,
    SUM(${usageExpr}) AS usage_amount,
    COUNT(*) AS row_count
  FROM read_parquet('${sqlEscapeString(srcGlob)}', union_by_name=true)
  GROUP BY ${groupByPositions}
) TO '${sqlEscapeString(dest)}' (FORMAT PARQUET, COMPRESSION ZSTD)
`.trim();
}

/** SQL projection from raw CUR columns to a buildSource-named output column.
 *  Mirrors the COALESCE shape buildSource uses so values stay byte-identical. */
function rawProjectionFor(field: string, has: (col: string) => boolean): string {
  switch (field) {
    case 'usage_date':
      return `line_item_usage_start_date::DATE`;
    case 'account_id':
      return `line_item_usage_account_id`;
    case 'account_name':
      return has('line_item_usage_account_name') ? `COALESCE(line_item_usage_account_name, '')` : `''`;
    case 'region':
      return has('product_region_code') ? `COALESCE(product_region_code, '')` : `''`;
    case 'service':
      return has('product_servicecode') ? `COALESCE(product_servicecode, '')` : `''`;
    case 'service_family':
      return has('product_product_family') ? `COALESCE(product_product_family, '')` : `''`;
    case 'line_item_type':
      return has('line_item_line_item_type') ? `COALESCE(line_item_line_item_type, '')` : `''`;
    case 'usage_type':
      return has('line_item_usage_type') ? `COALESCE(line_item_usage_type, '')` : `''`;
    case 'operation':
      return has('line_item_operation') ? `COALESCE(line_item_operation, '')` : `''`;
    default:
      // Unknown built-in field: defensively project NULL so the GROUP BY
      // doesn't error. Schema invariant: this should not happen for
      // dimensions that came out of deriveRollupSchema's allow-list.
      return `NULL`;
  }
}

/**
 * Hash of the raw parquet etags for a period. Two builds with the same hash
 * see the same raw bytes — used as a cheap "is this rollup still in sync with
 * raw?" check, paired with the schema hash.
 */
export function hashRawEtags(periodEtags: Readonly<Record<string, string>>): string {
  // Sort keys so the hash is order-independent across Node versions / OSes.
  const sortedKeys = Object.keys(periodEtags).sort();
  const sorted = sortedKeys.map(k => `${k}\0${periodEtags[k] ?? ''}`).join('\n');
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

export interface BuildOnePeriodOptions {
  readonly dataDir: string;
  readonly period: string;
  readonly schema: RollupSchema;
  readonly rawHash: string;
  readonly availableColumns: ReadonlySet<string> | undefined;
  /** Caller-supplied DuckDB query runner. Returns rows; we use it for the
   *  COPY ... TO ... and the row-count probe. The runner must be on the same
   *  DuckDB process that the rest of the app uses (no in-memory isolation). */
  readonly runQuery: (sql: string) => Promise<readonly unknown[]>;
}

export async function buildOnePeriod(opts: BuildOnePeriodOptions): Promise<RollupEntry> {
  const { dataDir, period, schema, rawHash, availableColumns, runQuery } = opts;
  await mkdir(rollupDir(dataDir), { recursive: true });

  const sql = buildRollupSql({ dataDir, period, schema, availableColumns });

  const startedAt = Date.now();
  await runQuery(sql);
  const elapsedMs = Date.now() - startedAt;

  // Probe rowCount from the freshly-written file. Cheap: parquet metadata read.
  const rowCountRows = await runQuery(
    `SELECT COUNT(*) AS n FROM read_parquet('${sqlEscapeString(rollupParquetPath(dataDir, period))}')`,
  );
  const rowCount = extractRowCount(rowCountRows);

  const entry: RollupEntry = {
    schemaHash: schema.hash,
    builtAt: new Date().toISOString(),
    rowCount,
    rawHash,
  };
  await upsertRollupEntry(dataDir, period, entry);

  logger.info('rollup-built', { period, rowCount, elapsedMs, schemaHash: schema.hash });
  return entry;
}

function extractRowCount(rows: readonly unknown[]): number {
  const first = rows[0];
  if (first === undefined || typeof first !== 'object' || first === null) return 0;
  const n = (first as Record<string, unknown>)['n'];
  if (typeof n === 'number') return n;
  if (typeof n === 'bigint') return Number(n);
  if (typeof n === 'string') {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
