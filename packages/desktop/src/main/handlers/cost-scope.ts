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
  CostScopePreviewResult,
  CostScopePreviewRow,
  DimensionsConfig,
} from '@costgoblin/core';
import { listLocalMonths } from '@costgoblin/core';
import type { AppContext } from './context.js';
import { costColumnFor } from '@costgoblin/core';
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
    };

    const available = await listLocalMonths(ctx.dataDir, 'daily');
    const required = computePeriodsInRange({ start: startStr, end: endStr });
    const periods = required.filter(p => available.includes(p));
    if (periods.length === 0) return zero;

    const dimensions = await getQueryDimensions();
    const orgPath = await getOrgAccountsPath();
    const costColumn = costColumnFor(config.costMetric);
    const source = buildSource(ctx.dataDir, 'daily', dimensions, orgPath, periods, undefined, costColumn);

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

    return { windowDays, startDate: startStr, endDate: endStr, perRule, combined };
  });

  ipcMain.handle('cost-scope:reveal-folder', (): void => {
    shell.showItemInFolder(ctx.costScopePath);
  });
}
