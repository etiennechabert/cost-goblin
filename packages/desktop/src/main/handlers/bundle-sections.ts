import { basename } from 'node:path';
import { logger } from '@costgoblin/core';
import { isEnoent } from '../fs-errors.js';

/** What a bundle does with a views.yaml that exists but doesn't load:
 *  `fail` (naming the file) for an export or publish the user asked for, so
 *  it never ships silently missing the dashboards; `skip` the section and log
 *  it for the LAN data share, whose peer would otherwise get a bare 500 for
 *  the data too. The user sees why on their dashboard either way. */
export type BrokenViews = 'fail' | 'skip';

/** An optional section that is left out when its file doesn't exist
 *  (ENOENT). A file that exists but doesn't load (a YAML or validation error,
 *  EACCES) is handled as `onBroken` says. */
export async function optionalSection<T>(path: string, load: () => Promise<T>, onBroken: BrokenViews): Promise<T | undefined> {
  try {
    return await load();
  } catch (err) {
    if (isEnoent(err)) return undefined;
    const file = basename(path);
    if (onBroken === 'skip') {
      logger.warn('Left a config file that does not load out of the shared configuration', { file });
      return undefined;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't load ${file} for the configuration bundle: ${detail}`, { cause: err });
  }
}
