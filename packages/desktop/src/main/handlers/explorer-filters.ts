import { asDimensionId, buildRuleMatchExpr, expandOrgNodeValues } from '@costgoblin/core';
import type { DimensionsConfig, ExclusionRule, ExplorerFilterMap, OrgNode } from '@costgoblin/core';
import { isOwnerGroupBy } from './query-utils.js';

/** The Explorer's filters as one SQL predicate, or null when none has a value.
 *  As in a dashboard filter (buildFilterClauses), '' keeps the rows with no
 *  value, a tag the resource lacks (NULL) as much as an empty one, and on the
 *  owner dimension an org-tree node's name keeps every value the node rolls up
 *  (`orgTree`, see filterOrgTree): the dashboard table widget gets the filter a
 *  click on a rolled-up slice sets. */
export function buildExplorerFilterPredicate(
  filters: ExplorerFilterMap,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]>,
  orgTree?: readonly OrgNode[],
): string | null {
  const conditions = Object.entries(filters)
    .filter(([, values]) => values.length > 0)
    .map(([dimId, values]) => {
      const named = values.filter(v => v !== '');
      return {
        dimensionId: asDimensionId(dimId),
        values: orgTree !== undefined && isOwnerGroupBy(dimId, dimensions) ? expandOrgNodeValues(orgTree, named) : named,
        matchMissing: values.includes(''),
      };
    });
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
