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
 * Validate a tier name before it is interpolated into a read_parquet path
 * literal (see `buildParquetSource`). Tiers are app-chosen ('daily'/'hourly'),
 * but the parameter travels through several exported builders, so the
 * interpolation site enforces the allow-list rather than trusting callers.
 * @throws {SecurityError} If the tier is not a known billing-data tier
 */
export function assertTier(value: string): void {
  if (!ALLOWED_TIERS.has(value)) {
    throw new SecurityError(
      `Invalid tier "${value}" - must be one of: ${[...ALLOWED_TIERS].join(', ')}. ` +
      `This prevents SQL injection via untrusted file paths.`
    );
  }
}

/**
 * Validate a billing period (YYYY-MM) before it is interpolated into a
 * read_parquet path literal (see `buildParquetSource`). Periods normally come
 * from `computePeriodsInRange`, but `buildSource` is exported and period lists
 * can also derive from on-disk directory names, so the interpolation site
 * validates every entry.
 * @throws {SecurityError} If the period is not a well-formed YYYY-MM string
 */
export function assertBillingPeriod(value: string): void {
  if (!BILLING_PERIOD_PATTERN.test(value)) {
    throw new SecurityError(
      `Invalid billing period "${value}" - must be YYYY-MM format. ` +
      `This prevents SQL injection via untrusted file paths.`
    );
  }
}

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

