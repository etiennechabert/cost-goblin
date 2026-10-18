import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { SEED_VIEWS_CONFIG, viewsConfigToYaml } from '@costgoblin/core';
import type { ViewsConfig } from '@costgoblin/core';
import { errnoCode, isEnoent } from '../fs-errors.js';

/** What `loadOrSeedViews` needs from the app context. */
export interface ViewsSource {
  readonly viewsPath: string;
  /** The (cached) views.yaml loader: rejects when the file is missing or
   *  doesn't parse and validate. */
  readonly getViews: () => Promise<ViewsConfig>;
  readonly invalidateViews: () => void;
}

/** The views for `views:get-config`. Only a missing views.yaml (ENOENT: the
 *  first run) gets the seed views. Any other failure (a YAML or validation
 *  error from a hand edit, EACCES) rejects, for the renderer to show, and
 *  leaves the file as it is: writing the seed over it would delete every
 *  custom view, with no backup. */
export async function loadOrSeedViews(source: ViewsSource): Promise<ViewsConfig> {
  try {
    return await source.getViews();
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  try {
    // `wx` only ever creates the file: one that appeared since the failed
    // read is loaded below, not replaced.
    await writeFile(source.viewsPath, stringify(viewsConfigToYaml(SEED_VIEWS_CONFIG)), { flag: 'wx' });
  } catch (err) {
    if (errnoCode(err) !== 'EEXIST') throw err;
    return source.getViews();
  }
  source.invalidateViews();
  return SEED_VIEWS_CONFIG;
}
