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
 *  as `parseDimensionsPayload`, except what a load repairs is rejected: the
 *  editor already refuses both, so a payload that still carries them is
 *  refused visibly instead of being silently rewritten on disk.
 *  - `nameStripPatterns` beyond the caps (16 patterns of at most 256
 *    characters), which a load drops;
 *  - two tags with the same dimension id, which a load disables.
 *  @throws {ConfigValidationError} when the payload is not a valid config */
export function parseDimensionsSavePayload(payload: unknown): DimensionsConfig {
  return parseDimensionsPayload(payload, { stripPatternLimits: 'reject', tagIdCollisions: 'reject' });
}

/** Parse a config the main process loaded and is writing back with one
 *  renderer-supplied change (an accepted alias suggestion). Same checks as a
 *  save, except a tag-id clash the loaded config already had stays as the load
 *  left it (the later tag disabled): this write didn't add it, and refusing it
 *  would fail every suggestion until the clash is fixed in Dimensions.
 *  @throws {ConfigValidationError} when the payload is not a valid config */
export function parseDimensionsRewritePayload(payload: unknown): DimensionsConfig {
  return parseDimensionsPayload(payload, { stripPatternLimits: 'reject', tagIdCollisions: 'disable' });
}

/** `config` with `aliases` added under `canonical` on the tag dimension whose
 *  resource tag is `tagName` (the first, as id lookups resolve), or null when
 *  no tag dimension reads that tag. */
export function withAcceptedAliasSuggestion(
  config: DimensionsConfig,
  tagName: string,
  canonical: string,
  aliases: readonly string[],
): DimensionsConfig | null {
  const tagIndex = config.tags.findIndex(t => t.tagName === tagName);
  const tag = config.tags[tagIndex];
  if (tag === undefined) return null;
  const tags = config.tags.map((t, i) => (i === tagIndex ? { ...t, aliases: { ...t.aliases, [canonical]: aliases } } : t));
  return { ...config, tags };
}
