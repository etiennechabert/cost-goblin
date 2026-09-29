/** Parsing for dimensions configs that arrive over IPC. Kept in its own module
 *  (no electron import) so it is unit-testable without the main process. */

import { validateDimensions } from '@costgoblin/core';
import type { DimensionsConfig, ValidateDimensionsOptions } from '@costgoblin/core';

/** Parse a renderer-supplied dimensions config. The renderer is not trusted:
 *  its payload goes through the same validator as a dimensions.yaml on disk
 *  (bare-identifier `field`/`displayField`, integer `pathSegment.index`, a
 *  source on every tag, ...) before anything reaches the filesystem or
 *  DuckDB. Handlers must use only the returned object.
 *  @throws {ConfigValidationError} when the payload is not a valid config */
export function parseDimensionsPayload(payload: unknown, options?: ValidateDimensionsOptions): DimensionsConfig {
  return validateDimensions(payload, options);
}

/** Parse a renderer-supplied config that is about to be PERSISTED. Same checks
 *  as `parseDimensionsPayload`, except `nameStripPatterns` beyond the caps
 *  (16 patterns of at most 256 characters) are rejected rather than dropped:
 *  the editor already refuses them, so a payload that still carries them is
 *  refused visibly instead of being silently truncated on disk.
 *  @throws {ConfigValidationError} when the payload is not a valid config */
export function parseDimensionsSavePayload(payload: unknown): DimensionsConfig {
  return parseDimensionsPayload(payload, { stripPatternLimits: 'reject' });
}
