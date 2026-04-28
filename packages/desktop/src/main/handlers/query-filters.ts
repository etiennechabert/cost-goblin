import { ipcMain } from 'electron';
import {
  buildSource,
  buildAliasSqlCase,
  buildRuleMatchExpr,
  computePeriodsInRange,
  tagColumnName,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  toNum,
  toStr,
} from './query-utils.js';

function resolveFieldExpr(
  dimensionId: string,
  dimensions: import('@costgoblin/core').DimensionsConfig,
): { field: string; fieldExpr: string } {
  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  const tag = dimensions.tags.find(d => tagColumnName(d.tagName) === dimensionId);
  const field = builtIn === undefined ? dimensionId : builtIn.field;
  let fieldExpr = field;
  if (builtIn !== undefined) fieldExpr = buildAliasSqlCase(field, builtIn);
  else if (tag !== undefined) fieldExpr = buildAliasSqlCase(field, tag);
  return { field, fieldExpr };
}

function buildFilterWhereClauses(
  filterEntries: Record<string, string>,
  dimensions: import('@costgoblin/core').DimensionsConfig,
  accountReverseMap: Map<string, readonly string[]>,
): string[] {
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(filterEntries)) {
    const fb = dimensions.builtIn.find(d => d.name === key);
    const ft = dimensions.tags.find(d => tagColumnName(d.tagName) === key);
    const ff = fb === undefined ? key : fb.field;
    let ffExpr = ff;
    if (fb !== undefined) ffExpr = buildAliasSqlCase(ff, fb);
    else if (ft !== undefined) ffExpr = buildAliasSqlCase(ff, ft);

    if (ff === 'account_id') {
      const ids = accountReverseMap.get(value);
      if (ids !== undefined && ids.length > 0) {
        const list = ids.map(id => `'${id.replaceAll("'", "''")}'`).join(', ');
        clauses.push(`${ff} IN (${list})`);
        continue;
      }
    }
    clauses.push(`${ffExpr} = '${value.replaceAll("'", "''")}'`);
  }
  return clauses;
}

function buildExclusionWhereClauses(
  costScope: import('@costgoblin/core').CostScopeConfig | undefined,
  dimensions: import('@costgoblin/core').DimensionsConfig,
  accountReverseMap: Map<string, readonly string[]>,
): string[] {
  if (costScope === undefined) return [];
  const clauses: string[] = [];
  for (const rule of costScope.rules) {
    if (!rule.enabled) continue;
    const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
    if (matchExpr !== null) clauses.push(`NOT (${matchExpr})`);
  }
  return clauses;
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
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getCostScope, getAvailableColumns, runQuery } = app;

  ipcMain.handle('query:filter-values', async (_event, dimensionId: string, filterEntries: Record<string, string>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }): Promise<{ value: string; label: string; count: number }[]> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const costScope = opts?.bypassCostScope === true
      ? undefined
      : await getCostScope().catch(() => undefined);

    const { fieldExpr } = resolveFieldExpr(dimensionId, dimensions);
    const whereClauses = [
      ...buildFilterWhereClauses(filterEntries, dimensions, accountReverseMap),
      ...buildExclusionWhereClauses(costScope, dimensions, accountReverseMap),
    ];
    if (dateRange !== undefined) {
      whereClauses.push(`usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const orgPath = await getOrgAccountsPath();
    const periods = dateRange === undefined ? undefined : computePeriodsInRange(dateRange);
    const availableColumns = await getAvailableColumns('daily');
    const source = buildSource({ dataDir: ctx.dataDir, tier: 'daily', dimensions, orgAccountsPath: orgPath, periods, costMetric: 'unblended', availableColumns });
    const sql = `
      SELECT ${fieldExpr} AS val, SUM(cost) AS total_cost
      FROM ${source}
      ${whereStr}
      GROUP BY val
      HAVING val IS NOT NULL AND val != ''
      ORDER BY total_cost DESC
      LIMIT 100
    `;

    const rows = await runQuery(sql);
    const isAccountDim = dimensionId === 'account' || dimensionId === 'account_id';
    if (isAccountDim) return mergeAccountRows(rows, accountMap);

    return rows.map(r => {
      const rawVal = toStr(r['val']);
      return { value: rawVal, label: rawVal, count: toNum(r['total_cost']) };
    });
  });
}
