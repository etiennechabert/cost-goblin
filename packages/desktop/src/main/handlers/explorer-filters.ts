import { asDimensionId, buildRuleMatchExpr } from '@costgoblin/core';
import type { DimensionsConfig, ExclusionRule, ExplorerFilterMap } from '@costgoblin/core';

/** The Explorer's filters as one SQL predicate, or null when none has a value.
 *  As in a dashboard filter (buildFilterClauses), '' keeps the rows with no
 *  value, a tag the resource lacks (NULL) as much as an empty one. */
export function buildExplorerFilterPredicate(
  filters: ExplorerFilterMap,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]>,
): string | null {
  const conditions = Object.entries(filters)
    .filter(([, values]) => values.length > 0)
    .map(([dimId, values]) => ({
      dimensionId: asDimensionId(dimId),
      values: values.filter(v => v !== ''),
      matchMissing: values.includes(''),
    }));
  if (conditions.length === 0) return null;
  const synthetic: ExclusionRule = {
    id: '_explorer_filters',
    name: '_explorer_filters',
    enabled: true,
    builtIn: false,
    conditions,
  };
  return buildRuleMatchExpr(synthetic, dimensions, accountReverseMap);
}
