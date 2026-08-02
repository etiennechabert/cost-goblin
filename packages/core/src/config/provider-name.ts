import { asProviderName } from '../types/branded.js';
import type { ProviderName } from '../types/branded.js';
import { RESERVED_WORKSPACE_NAMES, WORKSPACE_NAME_PATTERN } from './workspace-name.js';

/** Provider names share the workspace-name rules (letter/digit start, then
 *  letters, digits, hyphens, underscores, 64 chars max — see
 *  workspace-name.ts): the name becomes the on-disk directory segment
 *  `{dataDir}/{providerName}/` AND is interpolated into single-quoted SQL
 *  read_parquet globs, so separators, dots, quotes, and control characters
 *  must never pass. */
export const PROVIDER_NAME_PATTERN = WORKSPACE_NAME_PATTERN;

/** Layout names living inside a provider directory. Reserved defensively so
 *  a provider directory can never be confused with a layout directory during
 *  migrations or manual inspection. Windows device names are reserved for
 *  the same reason as workspace names (the name becomes a directory). */
export const RESERVED_PROVIDER_NAMES: readonly string[] = [
  ...RESERVED_WORKSPACE_NAMES,
  'RAW',
  'ROLLUP',
  'META',
];

export class ProviderNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNameError';
  }
}

export function isValidProviderName(raw: string): boolean {
  return PROVIDER_NAME_PATTERN.test(raw) && !RESERVED_PROVIDER_NAMES.includes(raw.toUpperCase());
}

/** Parses a raw string into a `ProviderName`, or throws a
 *  `ProviderNameError` whose message is friendly enough to surface directly
 *  in the UI. */
export function parseProviderName(raw: string): ProviderName {
  if (raw.length === 0) {
    throw new ProviderNameError('Provider name cannot be empty.');
  }
  if (raw.length > 64) {
    throw new ProviderNameError('Provider name must be 64 characters or fewer.');
  }
  if (RESERVED_PROVIDER_NAMES.includes(raw.toUpperCase())) {
    throw new ProviderNameError(`"${raw}" is a reserved name — please pick a different one.`);
  }
  if (!PROVIDER_NAME_PATTERN.test(raw)) {
    throw new ProviderNameError(
      'Provider names must start with a letter or number and may only contain letters, numbers, hyphens, and underscores.',
    );
  }
  return asProviderName(raw);
}
