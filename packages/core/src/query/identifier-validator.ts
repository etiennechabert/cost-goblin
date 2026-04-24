import type { DimensionsConfig } from '../types/config.js';
import { tagColumnName } from '../types/branded.js';

/**
 * Error thrown when SQL identifier validation fails.
 * Prevents SQL injection via untrusted column names or table paths.
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Standard CUR column names that are always safe to reference.
 * Includes both raw CUR fields and derived columns created in buildSource.
 */
const ALLOWED_CUR_COLUMNS = new Set([
  // Date/time columns (computed in buildSource)
  'usage_date',
  'usage_hour',

  // Core identity columns
  'account_id',
  'account_name',
  'region',
  'service',
  'service_family',

  // Cost columns
  'cost',
  'list_cost',

  // Resource and usage columns
  'description',
  'resource_id',
  'usage_amount',
  'line_item_type',
  'operation',
  'usage_type',

  // Raw CUR fields that may appear in queries
  'line_item_usage_account_id',
  'line_item_usage_account_name',
  'product_region_code',
  'product_servicecode',
  'product_product_family',
  'line_item_line_item_description',
  'line_item_resource_id',
  'line_item_usage_amount',
  'line_item_unblended_cost',
  'line_item_blended_cost',
  'pricing_public_on_demand_cost',
  'line_item_line_item_type',
  'line_item_operation',
  'line_item_usage_type',
  'line_item_usage_start_date',
  'savings_plan_savings_plan_effective_cost',
  'reservation_effective_cost',
  'resource_tags',

  // Aggregate and computed columns that appear in CTEs
  'entity',
  'total_cost',
  'current_cost',
  'previous_cost',
  'delta',
  'percent_change',
  'service_cost',
  'has_tag',
  'tagged_ratio',
  'days',

  // Org account columns (from org-accounts.json join)
  'id',
  'tags',
]);

/**
 * Build the set of valid column names from the dimensions config.
 * Includes built-in dimension fields, tag columns, and standard CUR columns.
 */
function buildAllowedColumns(dimensions: DimensionsConfig): ReadonlySet<string> {
  const allowed = new Set(ALLOWED_CUR_COLUMNS);

  // Add built-in dimension fields
  for (const dim of dimensions.builtIn) {
    allowed.add(dim.field);
    if (dim.displayField !== undefined) {
      allowed.add(dim.displayField);
    }
  }

  // Add tag columns (normalized tag names)
  for (const tag of dimensions.tags) {
    const col = tagColumnName(tag.tagName);
    allowed.add(col);
    allowed.add(`fallback_${col}`);
  }

  return allowed;
}

/**
 * Validate a column name against the dimensions config allow-list.
 * Throws SecurityError if the column name is not in the allow-list.
 *
 * @param columnName - The column name to validate (e.g., 'account_id', 'tag_team')
 * @param dimensions - The dimensions config containing built-in and tag definitions
 * @throws {SecurityError} If the column name is not in the allow-list
 */
export function validateColumnName(columnName: string, dimensions: DimensionsConfig): void {
  const allowed = buildAllowedColumns(dimensions);

  if (!allowed.has(columnName)) {
    throw new SecurityError(
      `Invalid column name "${columnName}" - not in dimensions config allow-list. ` +
      `This prevents SQL injection via untrusted identifiers.`
    );
  }
}

/**
 * Valid table path tiers (CUR data organization levels).
 */
const ALLOWED_TIERS = new Set(['daily', 'hourly', 'cost-optimization']);

/**
 * Pattern for valid billing period strings (YYYY-MM format).
 * Matches YYYY-MM where MM is 01-12.
 */
const BILLING_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Validate a table path for Parquet file reads.
 * Accepts paths in the format: {dataDir}/aws/raw/{tier}-{period}/*.parquet
 * or the wildcard format: {dataDir}/aws/raw/{tier}-*\/*.parquet
 *
 * @param tablePath - The table path to validate
 * @throws {SecurityError} If the table path does not match the expected pattern
 */
export function validateTablePath(tablePath: string): void {
  // Extract the tier and period from the path
  // Expected formats:
  // 1. {dataDir}/aws/raw/daily-2026-03/*.parquet
  // 2. {dataDir}/aws/raw/daily-*\/*.parquet
  // 3. read_parquet('{dataDir}/aws/raw/daily-2026-03/*.parquet')
  // 4. read_parquet(['{path1}', '{path2}'])

  // Strip read_parquet wrapper if present
  const cleanPath = tablePath
    .replace(/^read_parquet\s*\(\s*/, '')
    .replace(/\s*\)\s*$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/^['"]/, '')
    .replace(/['"]$/, '');

  // Match the tier and period pattern
  // Pattern: {anything}/aws/raw/{tier}-{period}/*.parquet
  const tierPattern = /\/aws\/raw\/([a-z-]+)-([^/]+)\/\*\.parquet/;
  const match = tierPattern.exec(cleanPath);

  if (match === null) {
    throw new SecurityError(
      `Invalid table path "${tablePath}" - must match pattern ` +
      `"{dataDir}/aws/raw/{tier}-{period}/*.parquet" or "{dataDir}/aws/raw/{tier}-*/*.parquet". ` +
      `This prevents SQL injection via untrusted file paths.`
    );
  }

  const tier = match[1];
  const period = match[2];

  // Validate tier is in allow-list
  if (tier === undefined || !ALLOWED_TIERS.has(tier)) {
    throw new SecurityError(
      `Invalid tier "${String(tier)}" in table path "${tablePath}" - ` +
      `must be one of: ${[...ALLOWED_TIERS].join(', ')}. ` +
      `This prevents SQL injection via untrusted identifiers.`
    );
  }

  // Validate period is either wildcard or valid YYYY-MM format
  if (period !== '*' && (period === undefined || !BILLING_PERIOD_PATTERN.test(period))) {
    throw new SecurityError(
      `Invalid period "${String(period)}" in table path "${tablePath}" - ` +
      `must be "*" or YYYY-MM format. ` +
      `This prevents SQL injection via untrusted identifiers.`
    );
  }
}
