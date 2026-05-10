import { logger } from '@costgoblin/core';

/**
 * Parse a base64-encoded cursor string into an offset number.
 * Returns 0 if cursor is undefined, invalid, or decodes to a negative number.
 *
 * @param cursor - Base64-encoded offset string from previous query result
 * @returns Parsed offset number, or 0 if invalid
 */
export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') {
    return 0;
  }

  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const offset = Number.parseInt(decoded, 10);

    if (Number.isNaN(offset)) {
      logger.warn('pagination:cursor', { reason: 'non-numeric', cursor });
      return 0;
    }

    if (offset < 0) {
      logger.warn('pagination:cursor', { reason: 'negative', offset });
      return 0;
    }

    return offset;
  } catch (error) {
    logger.warn('pagination:cursor', { reason: 'decode-failed', cursor, error });
    return 0;
  }
}

/**
 * Encode an offset number as a base64 cursor string.
 *
 * @param offset - Row offset for next page (0-based)
 * @returns Base64-encoded cursor string
 */
export function encodeCursor(offset: number): string {
  const value = String(offset);
  return Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * Clamp a page size to valid bounds [1, maxSize].
 * Non-integer values are floored.
 *
 * @param n - Requested page size
 * @param maxSize - Maximum allowed page size
 * @returns Clamped page size in range [1, maxSize]
 */
export function clampPageSize(n: number, maxSize: number): number {
  const value = Math.floor(n);
  if (value < 1) return 1;
  if (value > maxSize) return maxSize;
  return value;
}
