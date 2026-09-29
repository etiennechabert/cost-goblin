/** Parsing for dimensions configs that arrive over IPC. Kept in its own module
 *  (no electron import) so it is unit-testable without the main process. */

import { validateDimensions } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';

/** Parse a renderer-supplied dimensions config. The renderer is not trusted:
 *  its payload goes through the same validator as a dimensions.yaml on disk
 *  (bare-identifier `field`/`displayField`, integer `pathSegment.index`, a
 *  source on every tag, ...) before anything reaches the filesystem or
 *  DuckDB. Handlers must use only the returned object.
 *  @throws {ConfigValidationError} when the payload is not a valid config */
export function parseDimensionsPayload(payload: unknown): DimensionsConfig {
  return validateDimensions(payload);
}
