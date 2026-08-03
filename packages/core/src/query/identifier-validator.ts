import type { DimensionsConfig } from '../types/config.js';
import { tagDimColumn } from '../types/branded.js';

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
 * Standard column names that are always safe to reference. Includes the
 * canonical columns created in buildSource's projection and the raw
 * FOCUS 1.2 fields the projection reads.
 */
const ALLOWED_COLUMNS = new Set([
  // Date/time columns (computed in buildSource)
  'usage_date',
  'usage_hour',

  // Injected at read time: which configured provider a row came from
  // (constant column per provider branch — see buildSource).
  'provider',

  // Core identity columns
  'account_id',
  'account_name',
  'region',
  'service',
  'service_code',
  'service_category',

  // Cost columns
  'cost',
  'list_cost',

  // Resource and usage columns
  'description',
  'resource_id',
  'usage_amount',
  'charge_category',
  'pricing_category',
  'commitment_status',
  'operation',
  'sku_meter',

  // Raw FOCUS 1.2 fields that may appear in queries
  'ChargePeriodStart',
  'ChargePeriodEnd',
  'BillingPeriodStart',
  'SubAccountId',
  'SubAccountName',
  'RegionId',
  'RegionName',
  'ServiceName',
  'ServiceCategory',
  'ServiceSubcategory',
  'ChargeDescription',
  'ChargeCategory',
  'ChargeClass',
  'PricingCategory',
  'CommitmentDiscountStatus',
  'CommitmentDiscountId',
  'CommitmentDiscountName',
  'CommitmentDiscountType',
  'ConsumedQuantity',
  'ConsumedUnit',
  'ResourceId',
  'ResourceName',
  'ResourceType',
  'BilledCost',
  'EffectiveCost',
  'ListCost',
  'ContractedCost',
  'PublisherName',
  'InvoiceIssuerName',
  'SkuMeter',
  'Tags',
  'x_Operation',
  'x_ServiceCode',
  'x_Discounts',

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
  const allowed = new Set(ALLOWED_COLUMNS);

  // Add built-in dimension fields
  for (const dim of dimensions.builtIn) {
    allowed.add(dim.field);
    if (dim.displayField !== undefined) {
      allowed.add(dim.displayField);
    }
  }

  // Add tag columns (normalized tag names)
  for (const tag of dimensions.tags) {
    const col = tagDimColumn(tag);
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
 * A bare, injection-safe SQL column identifier: a leading letter or underscore
 * followed by letters, digits, or underscores.
 *
 * A built-in dimension's `field`/`displayField` is interpolated into SQL as a
 * bare identifier — `${field} IN (...)`, `MAX(${field})`, `LOWER(${field})` —
 * so quotes, parentheses, whitespace, or semicolons could break out of the
 * identifier position. A config can arrive from another user (shared bundle /
 * imported snapshot), so these strings are untrusted: anything not matching
 * this shape is rejected. A character-shape check (rather than a fixed column
 * allow-list) stays airtight without rejecting legitimately-named columns.
 */
const SAFE_COLUMN_IDENTIFIER = /^[A-Za-z_]\w*$/;

/** True when `name` is a bare SQL column identifier safe to interpolate. */
export function isSafeColumnIdentifier(name: string): boolean {
  return SAFE_COLUMN_IDENTIFIER.test(name);
}

/**
 * Valid table path tiers (billing-data organization levels).
 */
const ALLOWED_TIERS = new Set(['daily', 'hourly', 'cost-optimization']);

/**
 * Pattern for valid billing period strings (YYYY-MM format).
 * Matches YYYY-MM where MM is 01-12.
 */
const BILLING_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Pattern for valid YYYY-MM-DD date strings.
 */
const DATE_STRING_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Validate that a string is a well-formed YYYY-MM-DD date.
 * Throws SecurityError if the format is invalid, preventing SQL injection
 * via date values interpolated into queries.
 */
export function assertDateString(value: string): void {
  if (!DATE_STRING_PATTERN.test(value)) {
    throw new SecurityError(
      `Invalid date string "${value}" - must be YYYY-MM-DD format. ` +
      `This prevents SQL injection via untrusted date values.`
    );
  }
}

/**
 * Pattern for valid YYYY-MM-DD HH:00:00 hour strings.
 */
const HOUR_STRING_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):00:00$/;

/**
 * Validate that a string is a well-formed YYYY-MM-DD HH:00:00 hour timestamp.
 * Throws SecurityError if the format is invalid, preventing SQL injection
 * via hour values interpolated into queries.
 */
export function assertHourString(value: string): void {
  if (!HOUR_STRING_PATTERN.test(value)) {
    throw new SecurityError(
      `Invalid hour string "${value}" - must be YYYY-MM-DD HH:00:00 format. ` +
      `This prevents SQL injection via untrusted hour values.`
    );
  }
}

/**
 * Validate a table path for Parquet file reads.
 * Accepts paths in the format: {dataDir}/{providerName}/raw/{tier}-{period}/*.parquet
 * or the wildcard format: {dataDir}/{providerName}/raw/{tier}-*\/*.parquet
 *
 * The provider segment is validated against `allowedProviders` — the
 * configured provider names, which are themselves branded/validated. A path
 * naming any other provider directory is rejected: config files are
 * git-shareable, so the allow-list is the trust boundary.
 *
 * @param tablePath - The table path to validate
 * @param allowedProviders - Configured provider names (the only valid provider segments)
 * @throws {SecurityError} If the table path does not match the expected pattern
 */
export function validateTablePath(tablePath: string, allowedProviders: readonly string[]): void {
  // Extract the provider, tier, and period from the path
  // Expected formats:
  // 1. {dataDir}/{provider}/raw/daily-2026-03/*.parquet
  // 2. {dataDir}/{provider}/raw/daily-*\/*.parquet
  // 3. read_parquet('{dataDir}/{provider}/raw/daily-2026-03/*.parquet')
  // 4. read_parquet(['{path1}', '{path2}'])

  // Strip read_parquet wrapper if present
  const cleanPath = tablePath
    .replace(/^read_parquet\s*\(\s*/, '')
    .trimEnd()
    .replace(/\)$/, '')
    .trimStart()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/^['"]/, '')
    .replace(/['"]$/, '');

  // Match the provider, tier, and period pattern
  // Pattern: {anything}/{provider}/raw/{tier}-{period}/*.parquet
  const tierPattern = /\/([A-Za-z0-9][A-Za-z0-9_-]*)\/raw\/([a-z]+(?:-[a-z]+)*)-([^/]+)\/\*\.parquet/;
  const match = tierPattern.exec(cleanPath);

  if (match === null) {
    throw new SecurityError(
      `Invalid table path "${tablePath}" - must match pattern ` +
      `"{dataDir}/{provider}/raw/{tier}-{period}/*.parquet" or "{dataDir}/{provider}/raw/{tier}-*/*.parquet". ` +
      `This prevents SQL injection via untrusted file paths.`
    );
  }

  const provider = match[1];
  const tier = match[2];
  const period = match[3];

  if (provider === undefined || !allowedProviders.includes(provider)) {
    throw new SecurityError(
      `Invalid provider "${String(provider)}" in table path "${tablePath}" - ` +
      `not a configured provider name. ` +
      `This prevents SQL injection via untrusted file paths.`
    );
  }

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
