import { ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import {
  DEFAULT_COST_SCOPE,
  ConfigValidationError,
  costScopeToYaml,
  validateCostScope,
  buildSource,
  buildRuleMatchExpr,
  computePeriodsInRange,
} from '@costgoblin/core';
import type {
  CostScopeConfig,
  CostScopeDailyRow,
  CostScopePreviewResult,
  CostScopePreviewRow,
  DimensionsConfig,
} from '@costgoblin/core';
import { listLocalMonths } from '@costgoblin/core';
import type { AppContext } from './context.js';
import { toNum } from './query-utils.js';

// Every rule's dimensionId must resolve to a known built-in or tag dimension.
// Dangling references silently become a bogus column reference in SQL, which
// errors *every* query (exclusion clauses are threaded into all of them), so
// catch it at save time rather than letting the whole app fail at query time.
function assertRuleDimensionsExist(config: CostScopeConfig, dimensions: DimensionsConfig): void {
  const knownIds = new Set<string>();
  for (const d of dimensions.builtIn) knownIds.add(String(d.name));
  for (const t of dimensions.tags) knownIds.add(`tag_${t.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`);
  for (const rule of config.rules) {
    for (const cond of rule.conditions) {
      const id = String(cond.dimensionId);
      if (!knownIds.has(id)) {
        throw new ConfigValidationError(
          `Rule '${rule.name}' references unknown dimension '${id}'. Available: ${[...knownIds].join(', ')}`,
        );
      }
    }
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

export function registerCostScopeHandlers(app: AppContext): void {
  const { ctx, getCostScope, invalidateCostScope, getQueryDimensions, getOrgAccountsPath, runQuery } = app;

  ipcMain.handle('cost-scope:get-config', async (): Promise<CostScopeConfig> => {
    try {
      return await getCostScope();
    } catch (err) {
      // Seed the file only when it's missing. Validation / YAML errors bubble
      // up to the UI so the user can fix their hand-edit — silently
      // overwriting would destroy their custom rules.
      if (!isEnoent(err)) throw err;
      await writeFile(ctx.costScopePath, stringify(costScopeToYaml(DEFAULT_COST_SCOPE)));
      invalidateCostScope();
      return DEFAULT_COST_SCOPE;
    }
  });

  ipcMain.handle('cost-scope:save-config', async (_event, raw: unknown): Promise<void> => {
    const validated = validateCostScope(raw);
    const dimensions = await getQueryDimensions();
    assertRuleDimensionsExist(validated, dimensions);
    await writeFile(ctx.costScopePath, stringify(costScopeToYaml(validated)));
    invalidateCostScope();
  });

  ipcMain.handle('cost-scope:preview', async (_event, payload: unknown): Promise<CostScopePreviewResult> => {
    const config = validateCostScope(payload);
    const enabledRules = config.rules.filter(r => r.enabled);

    const windowDays = 30;
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
    const endStr = endDate.toISOString().slice(0, 10);
    const startStr = startDate.toISOString().slice(0, 10);

    const zero: CostScopePreviewResult = {
      windowDays,
      startDate: startStr,
      endDate: endStr,
      perRule: enabledRules.map(r => ({ ruleId: r.id, excludedCost: 0, excludedRows: 0 })),
      combined: { excludedCost: 0, excludedRows: 0 },
      unscopedTotalCost: 0,
      scopedTotalCost: 0,
      dailyTotals: [],
    };

    const available = await listLocalMonths(ctx.dataDir, 'daily');
    const required = computePeriodsInRange({ start: startStr, end: endStr });
    const periods = required.filter(p => available.includes(p));
    if (periods.length === 0) return zero;

    const dimensions = await getQueryDimensions();
    const orgPath = await getOrgAccountsPath();
    const source = buildSource(ctx.dataDir, 'daily', dimensions, orgPath, periods, undefined, config.costMetric);

    const perRule: CostScopePreviewRow[] = [];

    for (const rule of enabledRules) {
      const matchExpr = buildRuleMatchExpr(rule, dimensions);
      if (matchExpr === null) {
        perRule.push({ ruleId: rule.id, excludedCost: 0, excludedRows: 0 });
        continue;
      }
      // CAST both aggregates to DOUBLE so the Node binding returns plain
      // numbers — SUM over DECIMAL (CUR 2.0) comes back as a Decimal object
      // and COUNT(*) as a BigInt, neither of which pass a `typeof === 'number'`
      // check. toNum handles the BigInt fallback for safety.
      const sql = `
        SELECT
          CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS excluded_cost,
          CAST(COUNT(*) AS DOUBLE) AS excluded_rows
        FROM ${source}
        WHERE usage_date BETWEEN '${startStr}' AND '${endStr}'
          AND (${matchExpr})
      `.trim();
      try {
        const rows = await runQuery(sql);
        const row = rows[0];
        perRule.push({
          ruleId: rule.id,
          excludedCost: toNum(row?.['excluded_cost']),
          excludedRows: toNum(row?.['excluded_rows']),
        });
      } catch {
        perRule.push({ ruleId: rule.id, excludedCost: 0, excludedRows: 0 });
      }
    }

    let combined = { excludedCost: 0, excludedRows: 0 };
    if (enabledRules.length > 0) {
      const matchExprs = enabledRules
        .map(r => buildRuleMatchExpr(r, dimensions))
        .filter((e): e is string => e !== null);

      if (matchExprs.length > 0) {
        const combinedExpr = matchExprs.map(e => `(${e})`).join(' OR ');
        const combinedSql = `
          SELECT
            CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS excluded_cost,
            CAST(COUNT(*) AS DOUBLE) AS excluded_rows
          FROM ${source}
          WHERE usage_date BETWEEN '${startStr}' AND '${endStr}'
            AND (${combinedExpr})
        `.trim();
        try {
          const rows = await runQuery(combinedSql);
          const row = rows[0];
          combined = {
            excludedCost: toNum(row?.['excluded_cost']),
            excludedRows: toNum(row?.['excluded_rows']),
          };
        } catch {
          // empty data dir — return zeros
        }
      }
    }

    // Build the `excluded` predicate (OR of every enabled rule's match expr)
    // for the daily breakdown + totals. If no rules or no expressible rules,
    // `excludedPredicate` is the literal `FALSE` — nothing excluded — which
    // keeps the SQL uniform and lets the kept/excluded split still work.
    const matchExprs = enabledRules
      .map(r => buildRuleMatchExpr(r, dimensions))
      .filter((e): e is string => e !== null);
    const excludedPredicate = matchExprs.length > 0
      ? matchExprs.map(e => `(${e})`).join(' OR ')
      : 'FALSE';

    let unscopedTotalCost = 0;
    let scopedTotalCost = 0;
    let dailyTotals: readonly CostScopeDailyRow[] = [];
    try {
      const totalsSql = `
        SELECT
          CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS unscoped_total,
          CAST(COALESCE(SUM(CASE WHEN (${excludedPredicate}) THEN 0 ELSE cost END), 0) AS DOUBLE) AS scoped_total
        FROM ${source}
        WHERE usage_date BETWEEN '${startStr}' AND '${endStr}'
      `.trim();
      const totalsRows = await runQuery(totalsSql);
      const t = totalsRows[0];
      unscopedTotalCost = toNum(t?.['unscoped_total']);
      scopedTotalCost = toNum(t?.['scoped_total']);

      const dailySql = `
        SELECT
          usage_date::VARCHAR AS date,
          CAST(COALESCE(SUM(CASE WHEN (${excludedPredicate}) THEN 0 ELSE cost END), 0) AS DOUBLE) AS kept_cost,
          CAST(COALESCE(SUM(CASE WHEN (${excludedPredicate}) THEN cost ELSE 0 END), 0) AS DOUBLE) AS excluded_cost
        FROM ${source}
        WHERE usage_date BETWEEN '${startStr}' AND '${endStr}'
        GROUP BY usage_date
        ORDER BY usage_date
      `.trim();
      const dailyRows = await runQuery(dailySql);
      dailyTotals = dailyRows.map(r => {
        const raw = r['date'];
        const date = typeof raw === 'string' ? raw : raw instanceof Date ? raw.toISOString().slice(0, 10) : '';
        return {
          date,
          keptCost: toNum(r['kept_cost']),
          excludedCost: toNum(r['excluded_cost']),
        };
      });
    } catch {
      // Data-dir transient error — fall through with zeros. Per-rule totals
      // were computed in their own try-blocks so they stand on their own.
    }

    return {
      windowDays,
      startDate: startStr,
      endDate: endStr,
      perRule,
      combined,
      unscopedTotalCost,
      scopedTotalCost,
      dailyTotals,
    };
  });

  ipcMain.handle('cost-scope:reveal-folder', (): void => {
    shell.showItemInFolder(ctx.costScopePath);
  });
}
