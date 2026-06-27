import { BASE_COLUMNS, TRAILING_COLUMNS } from '../components/data-table.js';
import type { ColumnSpec } from '../components/data-table.js';
import type { ExplorerFilterMap, FilterMap } from '@costgoblin/core/browser';

function hasDimId(c: ColumnSpec): c is ColumnSpec & { dimId: string } {
  return c.dimId !== null;
}

/** Convert the dashboard's dimension-keyed FilterMap into the explorer query's
 *  ExplorerFilterMap, dropping unset dimensions. */
export function toExplorerFilters(filters: FilterMap): ExplorerFilterMap {
  const map: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined) map[k] = v;
  }
  return map;
}

const DIM_TO_COLUMN: ReadonlyMap<string, string> = new Map(
  [...BASE_COLUMNS, ...TRAILING_COLUMNS].filter(hasDimId).map(c => [c.dimId, c.key]),
);

/** Resolve a dimension id to its aggregated-table column key. Built-ins can
 *  differ from the dimension id (e.g. `account` → `account_name`); tag
 *  dimensions use their `tag_*` id directly, which is already the column key. */
export function dimToColumnKey(dimId: string): string {
  return DIM_TO_COLUMN.get(dimId) ?? dimId;
}
