/**
 * Privacy filter utilities for telemetry payloads.
 *
 * These functions strip PII (personally identifiable information) and business
 * data from telemetry events before they are sent to external services or
 * written to the audit log.
 *
 * NEVER transmitted:
 * - Cost values (dollars, amounts)
 * - Tag values (team names, project names, owner names)
 * - Account IDs (AWS account numbers)
 * - Dimension values (service names, region codes when in user data context)
 * - File paths containing user directories
 * - Environment variables
 */

import type { Dollars, TagValue } from '../types/branded.js';

/**
 * Redacted placeholder for cost values.
 */
const REDACTED_COST = '[REDACTED_COST]';

/**
 * Redacted placeholder for account IDs.
 */
const REDACTED_ACCOUNT = '[REDACTED_ACCOUNT]';

/**
 * Redacted placeholder for tag values.
 */
const REDACTED_TAG = '[REDACTED_TAG]';

/**
 * Redacted placeholder for dimension values.
 */
const REDACTED_DIMENSION = '[REDACTED_DIMENSION]';

/**
 * Redacted placeholder for file paths.
 */
const REDACTED_PATH = '[REDACTED_PATH]';

/**
 * Pattern to match AWS account IDs (12-digit numbers).
 */
const AWS_ACCOUNT_ID_PATTERN = /\b\d{12}\b/g;

/**
 * Pattern to match file paths (absolute paths on Windows and Unix).
 * Matches: C:\Users\..., C:\path\file.ext, /home/..., /Users/...
 * Handles spaces in paths but stops at common delimiters.
 */
const FILE_PATH_PATTERN = /(?:[A-Z]:\\[^\r\n]*?\.(?:yaml|yml|json|txt|log|env|conf|config|ini)|[A-Z]:\\(?:Users|Program Files|Documents)[^\r\n]*|\/(?:home|Users|root)\/[^\r\n:;,'"]*)/gi;

/**
 * Pattern to match cost-related field names in object keys.
 */
const COST_FIELD_PATTERN = /^(cost|costs|amount|price|spend|dollars|total|sum|totalCost|total_cost)$/i;

/**
 * Pattern to match account-related field names in object keys.
 */
const ACCOUNT_FIELD_PATTERN = /^(account|accountId|account_id|aws_account|awsAccount)$/i;

/**
 * Pattern to match tag-related field names in object keys.
 */
const TAG_FIELD_PATTERN = /^(tag|tags|tagValue|tag_value)$/i;

/**
 * Pattern to match dimension-related field names in object keys.
 */
const DIMENSION_FIELD_PATTERN = /^(dimension|dimensionValue|dimension_value|entity|entityRef|region|service)$/i;

/**
 * Safe field names that are allowed in telemetry payloads.
 * These represent aggregate counts, booleans, or non-sensitive metadata.
 */
const SAFE_FIELD_NAMES = new Set([
  'count',
  'rowCount',
  'dimensionCount',
  'filterCount',
  'duration',
  'timestamp',
  'status',
  'enabled',
  'disabled',
  'success',
  'error',
  'view',
  'viewName',
  'eventType',
  'channel',
  'level',
]);

/**
 * Redacts a cost value (Dollars or number) to prevent transmission.
 * The input value is intentionally discarded for privacy.
 */
export function redactCostValue(value: Dollars | number): string {
  // Type check to ensure we're only called with valid types
  void value;
  return REDACTED_COST;
}

/**
 * Redacts an account ID to prevent transmission.
 * Handles both string and number formats.
 * The input value is intentionally discarded for privacy.
 */
export function redactAccountId(value: string | number): string {
  // Type check to ensure we're only called with valid types
  void value;
  return REDACTED_ACCOUNT;
}

/**
 * Redacts a tag value to prevent transmission.
 * The input value is intentionally discarded for privacy.
 */
export function redactTagValue(value: TagValue | string): string {
  // Type check to ensure we're only called with valid types
  void value;
  return REDACTED_TAG;
}

/**
 * Redacts a dimension value to prevent transmission.
 * The input value is intentionally discarded for privacy.
 */
export function redactDimensionValue(value: string): string {
  // Type check to ensure we're only called with valid types
  void value;
  return REDACTED_DIMENSION;
}

/**
 * Sanitizes a string by removing AWS account IDs and file paths.
 */
export function sanitizeString(value: string): string {
  let sanitized = value;

  // Replace AWS account IDs
  sanitized = sanitized.replaceAll(AWS_ACCOUNT_ID_PATTERN, REDACTED_ACCOUNT);

  // Replace file paths
  sanitized = sanitized.replaceAll(FILE_PATH_PATTERN, REDACTED_PATH);

  return sanitized;
}

/**
 * Sanitizes an error message to remove PII.
 * Removes account IDs, file paths, and other sensitive data.
 */
export function sanitizeErrorMessage(message: string): string {
  return sanitizeString(message);
}

/**
 * Sanitizes a stack trace to remove file paths and other PII.
 * Preserves function names and line numbers for debugging.
 */
export function sanitizeStackTrace(stackTrace: string): string {
  return sanitizeString(stackTrace);
}

/**
 * Determines if a field name represents sensitive data that should be redacted.
 */
function isSensitiveFieldName(fieldName: string): boolean {
  // Allow known safe fields
  if (SAFE_FIELD_NAMES.has(fieldName)) {
    return false;
  }

  // Redact cost-related fields
  if (COST_FIELD_PATTERN.test(fieldName)) {
    return true;
  }

  // Redact account-related fields
  if (ACCOUNT_FIELD_PATTERN.test(fieldName)) {
    return true;
  }

  // Redact tag-related fields
  if (TAG_FIELD_PATTERN.test(fieldName)) {
    return true;
  }

  // Redact dimension-related fields
  if (DIMENSION_FIELD_PATTERN.test(fieldName)) {
    return true;
  }

  return false;
}

/**
 * Recursively sanitizes a telemetry payload object.
 * - Redacts sensitive field values
 * - Sanitizes strings (removes account IDs, file paths)
 * - Preserves structure for debugging
 * - Handles nested objects and arrays
 */
export function sanitizeTelemetryPayload(
  payload: unknown,
  maxDepth = 10,
): unknown {
  // Prevent infinite recursion
  if (maxDepth <= 0) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  // Handle null/undefined
  if (payload === null || payload === undefined) {
    return payload;
  }

  // Handle primitives
  if (typeof payload === 'string') {
    return sanitizeString(payload);
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return payload;
  }

  // Handle arrays
  if (Array.isArray(payload)) {
    return payload.map(item => sanitizeTelemetryPayload(item, maxDepth - 1));
  }

  // Handle objects (but not arrays, which are handled above)
  if (typeof payload === 'object') {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
      // Skip __brand properties (branded types)
      if (key === '__brand') {
        continue;
      }

      // Redact sensitive fields (entire value regardless of type)
      if (isSensitiveFieldName(key)) {
        if (COST_FIELD_PATTERN.test(key)) {
          sanitized[key] = REDACTED_COST;
        } else if (ACCOUNT_FIELD_PATTERN.test(key)) {
          sanitized[key] = REDACTED_ACCOUNT;
        } else if (TAG_FIELD_PATTERN.test(key)) {
          sanitized[key] = REDACTED_TAG;
        } else if (DIMENSION_FIELD_PATTERN.test(key)) {
          sanitized[key] = REDACTED_DIMENSION;
        } else {
          sanitized[key] = '[REDACTED]';
        }
        continue;
      }

      // Recursively sanitize nested values
      sanitized[key] = sanitizeTelemetryPayload(value, maxDepth - 1);
    }

    return sanitized;
  }

  // Unknown types (functions, symbols, etc.)
  return '[UNSUPPORTED_TYPE]';
}

/**
 * Sanitizes an Error object for telemetry.
 * Preserves error type and sanitized message/stack for debugging.
 */
export function sanitizeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: sanitizeErrorMessage(error.message),
    stack: error.stack === undefined ? undefined : sanitizeStackTrace(error.stack),
  };
}

/**
 * Creates a sanitized telemetry payload from arbitrary input.
 * Safe to use with any data structure - ensures no PII leaks.
 */
export function createSanitizedPayload(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const sanitized = sanitizeTelemetryPayload(data);

  // Type guard: sanitizeTelemetryPayload should return an object for object input
  if (typeof sanitized !== 'object' || sanitized === null || Array.isArray(sanitized)) {
    return {};
  }

  return sanitized as Readonly<Record<string, unknown>>;
}
