import { basename } from 'node:path';
import { logger, ManifestUnavailableError } from '@costgoblin/core';
import { isEnoent } from '../fs-errors.js';

/** What a bundle does with a section's file that exists but doesn't load:
 *  `fail`, naming the file, or `skip` the section and log it. */
export type BrokenSection = 'fail' | 'skip';

/** A bundle section's file exists but doesn't load (a YAML or validation
 *  error, EACCES), and the bundle can't go without it. */
export class BrokenSectionError extends Error {
  /** The file's name, as `cost-scope.yaml`. */
  readonly file: string;

  constructor(path: string, cause: unknown) {
    const file = basename(path);
    super(`Couldn't load ${file} for the configuration bundle: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'BrokenSectionError';
    this.file = file;
  }
}

/** An optional section that is left out when its file doesn't exist
 *  (ENOENT). A file that exists but doesn't load is handled as `onBroken`
 *  says. */
export async function optionalSection<T>(path: string, load: () => Promise<T>, onBroken: BrokenSection): Promise<T | undefined> {
  try {
    return await load();
  } catch (err) {
    if (isEnoent(err)) return undefined;
    if (onBroken === 'skip') {
      logger.warn('Left a config file that does not load out of the shared configuration', { file: basename(path) });
      return undefined;
    }
    throw new BrokenSectionError(path, err);
  }
}

/** What a LAN peer pulling a manifest is told about the failure that stopped
 *  it. A bundle section that didn't load becomes ManifestUnavailableError,
 *  which names the file and no more: the local error can quote a path. Any
 *  other failure passes through, and the peer gets a bare 500 for it. */
export function peerManifestError(err: unknown): Error {
  if (!(err instanceof BrokenSectionError)) return err instanceof Error ? err : new Error(String(err));
  logger.warn('Data sharing: a peer could not pull, a config file does not load', { file: err.file });
  return new ManifestUnavailableError(err.file, { cause: err });
}
