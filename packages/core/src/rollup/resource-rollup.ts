import type { DimensionsConfig } from '../types/config.js';
import { rollupGrainColumns } from './grain.js';

/**
 * The resource rollup: a second pre-aggregation, next to the rollup, for the
 * one grouping the rollup cannot hold. A table grouped by resource and
 * description has millions of groups a month, most of them tiny, so storing
 * them all would be the raw data again. This one stores the heaviest pairs
 * only, with what it takes to tell when they are the whole answer.
 *
 *  - A pair's WEIGHT in a month is the sum of the sizes of its line items'
 *    costs, SUM(ABS(cost)). No subset of those line items (some of the days,
 *    some of the accounts) can add up to more, in either direction.
 *  - Each month ranks its pairs by weight. Its top `pairsPerMonth` are HEAVY,
 *    and the weight of the first pair left out is the month's TAIL BOUND: no
 *    pair outside the top costs more than that there, whatever the filter.
 *  - The heavy set is the union of every month's top pairs, and every month
 *    stores the rows of every heavy pair it has, not only of its own top. So a
 *    stored pair is whole in every month, and a pair that is not stored is
 *    under the tail bound in every month.
 *
 * A page of the costliest pairs over a range is therefore exact as soon as
 * its last row costs more than the tail bounds of the range's months add up
 * to: nothing left out can reach it. A month with no pair left out is
 * COMPLETE, and answers any question about its pairs.
 */

/** Bump to invalidate every persisted resource rollup: its stored columns, or
 *  what a weight or a tail bound means, changed. */
export const RESOURCE_ROLLUP_SCHEMA_VERSION = 1;

/** How many pairs each month adds to the heavy set. Twenty thousand pairs are
 *  about 700,000 rows and 25 MB a month on a bill with nine million pairs a
 *  month, and leave the tail bound far under the 500th row of a dashboard
 *  that is not filtered down to a small slice. */
export const RESOURCE_ROLLUP_PAIRS_PER_MONTH = 20_000;

/** The pair a weight belongs to. Both are source columns (`buildSource`). */
export const RESOURCE_ROLLUP_KEY_COLUMNS: readonly string[] = ['resource_id', 'description'];

/** The measures a stored row carries: the rollup's, plus the two an
 *  aggregated-table row also returns. */
export const RESOURCE_ROLLUP_MEASURE_COLUMNS: readonly string[] = ['cost', 'list_cost', 'usage_amount', 'line_items'];

/** The non-aggregate columns of a resource rollup row: the rollup's grain
 *  (so a dashboard filter reads the same columns here), then the pair. A key
 *  column the grain already holds, because its dimension is enabled, is
 *  listed once. */
export function resourceRollupDimensionColumns(dims: DimensionsConfig): string[] {
  const grain = rollupGrainColumns(dims);
  return [...grain, ...RESOURCE_ROLLUP_KEY_COLUMNS.filter(c => !grain.includes(c))];
}
