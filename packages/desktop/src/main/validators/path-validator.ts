import { SecurityError } from '@costgoblin/core';

/**
 * Pattern for valid profile labels.
 * Only allows alphanumeric characters, hyphens, and underscores.
 * This prevents path traversal attacks via special characters.
 */
const VALID_LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a profile label for use in file paths.
 * Prevents path traversal attacks by rejecting labels containing:
 * - Path separators (/, \)
 * - Parent directory references (..)
 * - Null bytes
 * - Control characters
 * - Any non-alphanumeric characters except hyphens and underscores
 *
 * @param label - The profile label to validate (e.g., 'query-1', 'test_profile')
 * @throws {SecurityError} If the label contains unsafe characters or is empty
 *
 * @example
 * // Valid labels
 * validateProfileLabel('query-1');        // OK
 * validateProfileLabel('test_profile');   // OK
 * validateProfileLabel('benchmark-2024'); // OK
 *
 * @example
 * // Invalid labels (throw SecurityError)
 * validateProfileLabel('../../../etc/passwd');  // Path traversal
 * validateProfileLabel('test/label');           // Path separator
 * validateProfileLabel('test;label');           // Special character
 * validateProfileLabel('');                     // Empty string
 */
export function validateProfileLabel(label: string): void {
  // Reject empty strings
  if (label.length === 0) {
    throw new SecurityError(
      'Profile label cannot be empty. ' +
      'This prevents file path construction errors.'
    );
  }

  // Reject labels with unsafe characters
  if (!VALID_LABEL_PATTERN.test(label)) {
    throw new SecurityError(
      `Invalid profile label "${label}" - must contain only alphanumeric characters, hyphens, and underscores. ` +
      `This prevents path traversal attacks via special characters (/, \\, .., null bytes, etc.).`
    );
  }
}
