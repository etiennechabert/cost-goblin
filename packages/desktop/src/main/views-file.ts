import { stringify } from 'yaml';
import { hasErrnoCode, SEED_VIEWS_CONFIG, viewsConfigToYaml, writeFileAtomic } from '@costgoblin/core';
import type { ViewsConfig } from '@costgoblin/core';

// No electron import, so the views IPC handlers and the tests share it.

/** views.yaml and the (caching) loader that reads it. */
export interface ViewsFile {
  readonly path: string;
  /** Read, parse and validate the file. */
  readonly load: () => Promise<ViewsConfig>;
  /** Drop `load`'s cache once the file has been rewritten. */
  readonly invalidate: () => void;
}

/** Replace views.yaml whole, so a crash mid-write can't leave the user's
 *  dashboards truncated. */
export async function saveViews(file: ViewsFile, config: ViewsConfig): Promise<void> {
  await writeFileAtomic(file.path, stringify(viewsConfigToYaml(config)));
  file.invalidate();
}

/** The saved views; a missing file is seeded with the default dashboards so
 *  first-run users get a working dashboard without going through setup again.
 *  Only a missing file: one that fails to read (a transient lock), parse or
 *  validate (a hand-edit typo) holds the user's dashboards, so the error
 *  reaches the UI for them to fix rather than the file being overwritten. */
export async function loadViewsOrSeed(file: ViewsFile): Promise<ViewsConfig> {
  try {
    return await file.load();
  } catch (err: unknown) {
    if (!hasErrnoCode(err, ['ENOENT'])) throw err;
    await saveViews(file, SEED_VIEWS_CONFIG);
    return SEED_VIEWS_CONFIG;
  }
}
