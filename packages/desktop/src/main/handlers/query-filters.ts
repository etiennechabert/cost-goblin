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
  buildAccountReverseMap,
  toNum,
  toStr,
} from './query-utils.js';

export function registerFilterHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getOrgAccountsPath, getCostScope, getAvailableColumns, runQuery } = app;

  ipcMain.handle('query:filter-values', async (_event, dimensionId: string, filterEntries: Record<string, string>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }): Promise<{ value: string; label: string; count: number }[]> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = buildAccountReverseMap(accountMap);
    // Honour the cost-scope exclusions here too — a user who has
    // excluded Tax / RI purchases doesn't want those values showing up
    // in filter dropdowns either. The Cost Scope editor sets
    // bypassCostScope=true so its rule-condition autocomplete still
    // sees every available value when composing new rules.
    const costScope = opts?.bypassCostScope === true
      ? undefined
      : await getCostScope().catch(() => undefined);

    const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
    const tag = dimensions.tags.find(d => tagColumnName(d.tagName) === dimensionId);

    const field = builtIn === undefined ? dimensionId : builtIn.field;
    // Apply alias/normalize CASE for both built-ins and tags so the SQL
    // returns the same display values the cost queries see — including the
    // SSM-derived friendly region names spliced into Region's aliases.
    let fieldExpr = field;
    if (builtIn !== undefined) {
      fieldExpr = buildAliasSqlCase(field, builtIn);
    } else if (tag !== undefined) {
      fieldExpr = buildAliasSqlCase(field, tag);
    }

    const whereClauses: string[] = [];
    for (const [key, value] of Object.entries(filterEntries)) {
      const fb = dimensions.builtIn.find(d => d.name === key);
      const ft = dimensions.tags.find(d => tagColumnName(d.tagName) === key);
      const ff = fb === undefined ? key : fb.field;
      let ffExpr = ff;
      if (fb !== undefined) {
        ffExpr = buildAliasSqlCase(ff, fb);
      } else if (ft !== undefined) {
        ffExpr = buildAliasSqlCase(ff, ft);
      }
      // Account filters carry display names that may collapse N ids — same
      // expansion the SQL builder does in buildFilterClauses.
      if (ff === 'account_id') {
        const ids = accountReverseMap.get(value);
        if (ids !== undefined && ids.length > 0) {
          const list = ids.map(id => `'${id.replaceAll("'", "''")}'`).join(', ');
          whereClauses.push(`${ff} IN (${list})`);
          continue;
        }
      }
      whereClauses.push(`${ffExpr} = '${value.replaceAll("'", "''")}'`);
    }

    if (dateRange !== undefined) {
      whereClauses.push(`usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`);
    }

    if (costScope !== undefined) {
      // NOT (rule_match) per enabled rule — same shape buildExclusionClauses
      // emits for the main query builders. Apply the dim's reverse map
      // (account collapse) when the condition targets account_id.
      for (const rule of costScope.rules) {
        if (!rule.enabled) continue;
        const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
        if (matchExpr === null) continue;
        whereClauses.push(`NOT (${matchExpr})`);
      }
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const orgPath = await getOrgAccountsPath();
    const periods = dateRange === undefined ? undefined : computePeriodsInRange(dateRange);
    const availableColumns = await getAvailableColumns('daily');
    // filter-values doesn't need a specific metric — just needs source
    // with the fewest column constraints. Pass 'unblended' (always
    // present) plus the probed column set so the source query doesn't
    // reference missing columns.
    const source = buildSource(ctx.dataDir, 'daily', dimensions, orgPath, periods, 'unblended', availableColumns);
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
    if (isAccountDim) {
      // Roll N raw ids that resolve to the same display name into one entry —
      // value AND label are the display name so the picker shows a single row
      // and downstream filter matching uses the same display name (which the
      // SQL builder expands back to all underlying ids).
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
    return rows.map(r => {
      const rawVal = toStr(r['val']);
      return { value: rawVal, label: rawVal, count: toNum(r['total_cost']) };
    });
  });
}
