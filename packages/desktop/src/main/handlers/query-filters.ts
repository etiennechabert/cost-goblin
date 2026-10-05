import { ipcMain } from 'electron';
import {
  asDimensionId,
  asTagValue,
  buildExclusionClauses,
  buildFilterClauses,
  buildSource,
  computePeriodsInRange,
  resolveField,
  QueryBuilder,
} from '@costgoblin/core';
import type { DimensionId, FilterMap, TagValue } from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  columnForDimension,
  resolveRollupSource,
  toNum,
  toStr,
} from './query-utils.js';
import { originStore } from '../query-log.js';

/** Brand the renderer's string-keyed filter entries for `buildFilterClauses`,
 *  which resolves each id through `resolveField` (unknown ids throw) and binds
 *  every value on the QueryBuilder. */
function toFilterMap(filterEntries: Record<string, readonly string[]>): FilterMap {
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  for (const [key, values] of Object.entries(filterEntries)) {
    filters[asDimensionId(key)] = values.map(asTagValue);
  }
  return filters;
}

function mergeAccountRows(
  rows: import('../duckdb-client.js').RawRow[],
  accountMap: Map<string, string>,
): { value: string; label: string; count: number }[] {
  const merged = new Map<string, number>();
  for (const r of rows) {
    const rawVal = toStr(r['val']);
    const name = accountMap.get(rawVal) ?? rawVal;
    merged.set(name, (merged.get(name) ?? 0) + toNum(r['total_cost']));
  }
  return [...merged.entries()]
    .map(([name, cost]) => ({ value: name, label: name, count: cost }))
    .sort((a, b) => b.count - a.count);
}

export function registerFilterHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getCostScope, getQueryProviders, runPreparedQuery, rollupStore } = app;

  ipcMain.handle('query:filter-values', (_event, dimensionId: string, filterEntries: Record<string, readonly string[]>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }, origin?: string): Promise<{ value: string; label: string; count: number }[]> => originStore.run(origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const costScope = opts?.bypassCostScope === true
      ? undefined
      : await getCostScope().catch(() => undefined);

    const qb = new QueryBuilder();
    // Throws SecurityError for ids that match neither a built-in nor a tag
    // dimension — a renderer-supplied id must never reach the SQL verbatim.
    const { fieldExpr } = resolveField(asDimensionId(dimensionId), dimensions);

    const providers = await getQueryProviders('daily');
    const matSource = dateRange === undefined
      ? undefined
      : resolveRollupSource(rollupStore, providers, dateRange, 'daily', [
          // The other active filters are WHEREd against the same source.
          ...Object.keys(filterEntries).map(k => columnForDimension(dimensions, k)),
          columnForDimension(dimensions, dimensionId), 'cost',
        ]);

    const filterClauses = buildFilterClauses(toFilterMap(filterEntries), dimensions, accountReverseMap, qb);
    // Exclusions are baked into the rollup; only apply them on the raw path.
    const exclusionClauses = matSource === undefined
      ? buildExclusionClauses(costScope?.rules, dimensions, accountReverseMap, qb)
      : [];
    const whereClauses = [...filterClauses, ...exclusionClauses];

    // The rollup glob spans all months (NOT pre-windowed like the old in-memory
    // base), so the date filter must be applied on BOTH paths.
    if (dateRange !== undefined) {
      const startParam = qb.addParam(dateRange.start);
      const endParam = qb.addParam(dateRange.end);
      whereClauses.push(`usage_date BETWEEN ${startParam} AND ${endParam}`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    let source: string;
    if (matSource === undefined) {
      // Providers with no data on disk are dropped — their wildcard glob
      // would fail the whole union. No provider with data → empty result.
      const active = providers.filter(p => (p.availablePeriods ?? []).length > 0);
      if (active.length === 0) return [];
      const orgPath = await getOrgAccountsPath();
      const required = dateRange === undefined ? undefined : computePeriodsInRange(dateRange);
      source = buildSource({
        dataDir: ctx.dataDir, tier: 'daily', dimensions, orgAccountsPath: orgPath,
        providers: active.map(p => ({
          name: p.name,
          periods: required?.filter(m => p.availablePeriods?.includes(m) ?? false),
        })),
        costMetric: 'billed',
      });
    } else {
      source = matSource;
    }

    const sql = `
      SELECT ${fieldExpr} AS val, SUM(cost) AS total_cost
      FROM ${source}
      ${whereStr}
      GROUP BY val
      HAVING val IS NOT NULL AND val != ''
      ORDER BY total_cost DESC
      LIMIT 100
    `;

    const params = qb.build().params;
    const rows = await runPreparedQuery(sql, params, matSource !== undefined);
    const isAccountDim = dimensionId === 'account' || dimensionId === 'account_id';
    if (isAccountDim) return mergeAccountRows(rows, accountMap);

    return rows.map(r => {
      const rawVal = toStr(r['val']);
      return { value: rawVal, label: rawVal, count: toNum(r['total_cost']) };
    });
  }));
}
