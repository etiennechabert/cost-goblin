import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { DEFAULT_COST_SCOPE, costScopeToYaml } from '@costgoblin/core';
import type { CostScopeConfig } from '@costgoblin/core';
import { errnoCode, isEnoent } from '../fs-errors.js';

/** What `loadOrSeedCostScope` needs from the app context. */
export interface CostScopeSource {
  readonly costScopePath: string;
  /** The (cached) cost-scope.yaml loader: rejects when the file is missing or
   *  doesn't parse and validate. */
  readonly getCostScope: () => Promise<CostScopeConfig>;
}

/** The cost scope for `cost-scope:get-config`. Only a missing cost-scope.yaml
 *  (ENOENT: the first run) gets the defaults written. Any other failure (a
 *  YAML or validation error from a hand edit, EACCES) rejects, for the Cost
 *  Scope page to show, and leaves the file as it is: writing the defaults
 *  over it would delete every custom rule, with no backup. */
export async function loadOrSeedCostScope(source: CostScopeSource): Promise<CostScopeConfig> {
  try {
    return await source.getCostScope();
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  try {
    // `wx` only ever creates the file: one that appeared since the failed
    // read is loaded below, not replaced.
    await writeFile(source.costScopePath, stringify(costScopeToYaml(DEFAULT_COST_SCOPE)), { flag: 'wx' });
  } catch (err) {
    if (errnoCode(err) !== 'EEXIST') throw err;
    return source.getCostScope();
  }
  // Nothing to invalidate: the failed read cached nothing, and while the file
  // was missing the queries (and the rollup built from them) already applied
  // these defaults (costScopeForQueries).
  return DEFAULT_COST_SCOPE;
}

/** cost-scope.yaml exists but doesn't load, so no query can apply it. */
export class CostScopeLoadError extends Error {
  constructor(cause: unknown) {
    super(`Couldn't load cost-scope.yaml: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'CostScopeLoadError';
  }
}

/** The cost scope a query applies. A missing cost-scope.yaml means the
 *  defaults, the ones `loadOrSeedCostScope` writes. One that exists but
 *  doesn't load (a YAML or validation error, EACCES) rejects with
 *  CostScopeLoadError: run without it, every query would drop the user's
 *  cost metric and exclusion rules and show unscoped totals as if they were
 *  right. */
export async function costScopeForQueries(getCostScope: () => Promise<CostScopeConfig>): Promise<CostScopeConfig> {
  try {
    return await getCostScope();
  } catch (err) {
    if (isEnoent(err)) return DEFAULT_COST_SCOPE;
    throw new CostScopeLoadError(err);
  }
}
