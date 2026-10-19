import { createHash } from 'node:crypto';
import { withMissingSeedViews } from '../types/seed-views.js';
import type { ViewSpec, ViewsConfig } from '../types/views.js';
import { viewToYaml } from './views-serialize.js';

/** The per-widget-type showcase dashboards seeded built-in from v0.5.3 until the
 *  question-led set in SEED_VIEWS_CONFIG replaced them, each as the digest of
 *  its canonical form exactly as last seeded. The views themselves are in
 *  __fixtures__/views/seeded-v0.7.0.yaml, which the tests migrate. A
 *  v0.5.3-v0.6.x copy matches too: it differs only by the CUR-era
 *  service_family ids, which validateViews renames on load. */
const RETIRED_SEED_VIEW_DIGESTS: ReadonlyMap<string, string> = new Map([
  ['trend-lines', '465fe2f11a37d4501fd93cfdb952ecdb3efaeeb967d574cb34193494ad28635d'],
  ['stacked', '406a44546955f313fd2fe044941086b62b112baaffaa00ff86f10db880418025'],
  ['top-n', 'f966583e559fe03762fd0945ea457dde746bf484b4ce7c25c853879e77a24e53'],
  ['distribution', '2c37fc22da7d1decf7b0fef366cad0814fbc7b5634b8069ee32b3401a888d718'],
  ['treemap', '6ca8ba1e93a58d4e183eddf2d5a933dfd85df073a69726418e27bce7cca35651'],
  ['heatmap', '14908749e42910ad824f5619df4038c7d162e54641791e8554bb0e558bd84236'],
  ['movers', '95e941f8c45ef3f970814033430f377958eb9ec4ec9d9ec6a4df4182285be363'],
  ['line-items', '6b4f1851db08aade78dc84b344cb093fc15ae96248749dccdbd9210369760988'],
  ['drivers', '185e4aa1f74ee0fd890e6c7b7e83e7ce1d34a9b3cb56f3334a2e56a89646943f'],
  ['price-volume', '457824957b2870bc2c5694868bfee83d16511e2fa55377526e269a26b31931dc'],
  ['pacing', 'fe3b070e21c5d68c7f16712c381b991ecb19b9cda60c172d095e918882d6a8d7'],
  ['concentration', 'b497b90e6366a8b7368d9879dd8d9769cfbf39cdf5599dcdff1e6b92b390a0e2'],
]);

/** Ids of the retired showcase dashboards. A new seed view must not reuse one,
 *  or the migration below would treat it as retired. */
export const RETIRED_SEED_VIEW_IDS: ReadonlySet<string> = new Set(RETIRED_SEED_VIEW_DIGESTS.keys());

/** viewToYaml emits keys in a fixed order and drops unset optionals, so equal
 *  specs digest identically however they were built. */
function viewDigest(view: ViewSpec): string {
  return createHash('sha256').update(JSON.stringify(viewToYaml(view))).digest('hex');
}

export interface SeedViewsMigration {
  readonly config: ViewsConfig;
  /** True when the config differs from the input and should be persisted. */
  readonly changed: boolean;
}

/** Bring a views config seeded by an older version onto the current built-in
 *  set. A retired showcase dashboard still marked built-in is dropped when
 *  untouched; one the user edited is kept as their own dashboard (no longer
 *  built-in, so they can delete it). Only a config that carried a retired
 *  dashboard gains the missing built-ins, so a file without one is returned
 *  as is. */
export function migrateRetiredSeedViews(config: ViewsConfig): SeedViewsMigration {
  let sawRetired = false;
  const kept: ViewSpec[] = [];
  for (const view of config.views) {
    const retiredDigest = view.builtIn === true ? RETIRED_SEED_VIEW_DIGESTS.get(view.id) : undefined;
    if (retiredDigest === undefined) {
      kept.push(view);
      continue;
    }
    sawRetired = true;
    if (viewDigest(view) !== retiredDigest) kept.push({ ...view, builtIn: undefined });
  }
  if (!sawRetired) return { config, changed: false };
  return { config: { views: withMissingSeedViews(kept) }, changed: true };
}
