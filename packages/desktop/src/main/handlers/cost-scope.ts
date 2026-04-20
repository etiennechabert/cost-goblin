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
  logger,
  listLocalMonths,
} from '@costgoblin/core';
import type {
  CostScopeCapabilities,
  CostScopeConfig,
  CostScopeDailyRow,
  CostScopePreviewResult,
  CostScopePreviewRow,
  CostScopeSampleRow,
  DimensionsConfig,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import { toNum } from './query-utils.js';

const SAMPLE_ROW_LIMIT = 500;

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
  if (typeof err !== 'object' || err === null) return false;
  if (!('code' in err)) return false;
  return err.code === 'ENOENT';
}

export function registerCostScopeHandlers(app: AppContext): void {
  const { ctx, getCostScope, invalidateCostScope, getQueryDimensions, getOrgAccountsPath, getAvailableColumns, runQuery } = app;

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
      sampleRows: [],
      sampleTotalRowCount: 0,
      tagColumns: [],
    };

    const available = await listLocalMonths(ctx.dataDir, 'daily');
    const required = computePeriodsInRange({ start: startStr, end: endStr });
    const periods = required.filter(p => available.includes(p));
    if (periods.length === 0) return zero;

    const dimensions = await getQueryDimensions();
    const orgPath = await getOrgAccountsPath();
    const availableColumns = await getAvailableColumns('daily');

    const source = buildSource(ctx.dataDir, 'daily', dimensions, orgPath, periods, config.costMetric, availableColumns, config.costPerspective);

    // Pre-compute each rule's positive match expression once — used to
    // build the `excluded` predicate for the main aggregate query, each
    // per-rule tally, the daily breakdown, and the sample row flag. Rules
    // whose expression is null (all conditions empty) are treated as
    // no-ops and don't appear in the SQL at all.
    const ruleExprs: { readonly rule: typeof enabledRules[number]; readonly expr: string | null }[] =
      enabledRules.map(rule => ({ rule, expr: buildRuleMatchExpr(rule, dimensions) }));
    const liveExprs = ruleExprs.filter(e => e.expr !== null).map(e => e.expr as string);
    const excludedPredicate = liveExprs.length > 0
      ? liveExprs.map(e => `(${e})`).join(' OR ')
      : 'FALSE';

    const tagColumns = dimensions.tags.map(t => ({
      id: `tag_${t.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`,
      label: t.label,
    }));

    // === Query 1: every aggregate in one scan ===
    // Merges what used to be 5 separate queries (per-rule + combined +
    // unscoped total + scoped total + total row count) into a single pass.
    // DuckDB evaluates each SUM(CASE...) during the same scan, so the cost
    // is roughly one full scan regardless of how many rules are enabled.
    const ruleAggSelects = ruleExprs.map((entry, i) => {
      if (entry.expr === null) return `CAST(0 AS DOUBLE) AS rule_${String(i)}_cost,
          CAST(0 AS DOUBLE) AS rule_${String(i)}_rows`;
      return `CAST(COALESCE(SUM(CASE WHEN (${entry.expr}) THEN cost ELSE 0 END), 0) AS DOUBLE) AS rule_${String(i)}_cost,
          CAST(COALESCE(SUM(CASE WHEN (${entry.expr}) THEN 1 ELSE 0 END), 0) AS DOUBLE) AS rule_${String(i)}_rows`;
    }).join(',\n          ');

    const aggSql = `
      SELECT
        CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS unscoped_total,
        CAST(COALESCE(SUM(CASE WHEN (${excludedPredicate}) THEN 0 ELSE cost END), 0) AS DOUBLE) AS scoped_total,
        CAST(COALESCE(SUM(CASE WHEN (${excludedPredicate}) THEN cost ELSE 0 END), 0) AS DOUBLE) AS combined_excluded_cost,
        CAST(COALESCE(SUM(CASE WHEN (${excludedPredicate}) THEN 1 ELSE 0 END), 0) AS DOUBLE) AS combined_excluded_rows,
        CAST(COUNT(*) AS DOUBLE) AS total_rows${ruleAggSelects.length > 0 ? `,\n          ${ruleAggSelects}` : ''}
      FROM ${source}
      WHERE usage_date BETWEEN '${startStr}' AND '${endStr}'
    `.trim();

    // === Query 2: daily breakdown (separate because GROUP BY) ===
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

    // === Query 3: top-|cost| sample rows (separate because ORDER BY LIMIT) ===
    // CAST numerics to DOUBLE inside the CTE so DECIMAL-typed CUR columns
    // come back as plain numbers — bare source.cost would return a
    // DuckDBDecimalValue object and toNum would yield 0 for every row.
    // Partition-rank the rows so we always return up to SAMPLE_ROW_LIMIT
    // from EACH bucket (kept vs excluded) rather than top-|cost| of the
    // combined set. Otherwise a few very large excluded rows (tax, EDP
    // discount, RI upfront) eat the whole limit and the table looks
    // empty when the user toggles "Hide excluded" on.
    const tagSelectSql = tagColumns.length > 0
      ? tagColumns.map(t => `COALESCE(${t.id}, '') AS ${t.id}`).join(',\n          ')
      : null;
    const sampleSql = `
      WITH scoped AS (
        SELECT
          usage_date,
          account_id, account_name, region, service, service_family,
          line_item_type, operation, usage_type, description, resource_id,
          CAST(usage_amount AS DOUBLE) AS usage_amount,
          CAST(cost AS DOUBLE) AS cost,
          CAST(list_cost AS DOUBLE) AS list_cost,
          CASE WHEN (${excludedPredicate}) THEN 1 ELSE 0 END AS excluded${tagSelectSql === null ? '' : `,\n          ${tagSelectSql}`}
        FROM ${source}
        WHERE usage_date BETWEEN '${startStr}' AND '${endStr}'
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY excluded ORDER BY ABS(cost) DESC) AS rn
        FROM scoped
      )
      SELECT
        usage_date::VARCHAR AS usage_date,
        account_id, account_name, region, service, service_family,
        line_item_type, operation, usage_type, description, resource_id,
        usage_amount, cost, list_cost, excluded${tagSelectSql === null ? '' : ',\n        ' + tagColumns.map(t => t.id).join(', ')}
      FROM ranked
      WHERE rn <= ${String(SAMPLE_ROW_LIMIT)}
      ORDER BY excluded ASC, ABS(cost) DESC
    `.trim();

    // Run all three in parallel. The DuckDB worker pool (default size 4)
    // lets independent queries execute concurrently. `allSettled` so one
    // failing query doesn't drop the other two's results.
    const [aggResult, dailyResult, sampleResult] = await Promise.allSettled([
      runQuery(aggSql),
      runQuery(dailySql),
      runQuery(sampleSql),
    ]);

    // Agg → totals + per-rule + combined
    let unscopedTotalCost = 0;
    let scopedTotalCost = 0;
    let sampleTotalRowCount = 0;
    let combined = { excludedCost: 0, excludedRows: 0 };
    const perRule: CostScopePreviewRow[] = ruleExprs.map(e => ({
      ruleId: e.rule.id, excludedCost: 0, excludedRows: 0,
    }));
    if (aggResult.status === 'fulfilled') {
      const row = aggResult.value[0];
      unscopedTotalCost = toNum(row?.['unscoped_total']);
      scopedTotalCost = toNum(row?.['scoped_total']);
      sampleTotalRowCount = toNum(row?.['total_rows']);
      combined = {
        excludedCost: toNum(row?.['combined_excluded_cost']),
        excludedRows: toNum(row?.['combined_excluded_rows']),
      };
      for (let i = 0; i < ruleExprs.length; i++) {
        const entry = ruleExprs[i];
        const prev = perRule[i];
        if (entry === undefined || prev === undefined) continue;
        perRule[i] = {
          ruleId: entry.rule.id,
          excludedCost: toNum(row?.[`rule_${String(i)}_cost`]),
          excludedRows: toNum(row?.[`rule_${String(i)}_rows`]),
        };
      }
    } else {
      logger.warn(`cost-scope: agg query failed: ${aggResult.reason instanceof Error ? aggResult.reason.message : String(aggResult.reason)}`);
    }

    let dailyTotals: readonly CostScopeDailyRow[] = [];
    if (dailyResult.status === 'fulfilled') {
      dailyTotals = dailyResult.value.map(r => {
        const raw = r['date'];
        const date = typeof raw === 'string' ? raw : raw instanceof Date ? raw.toISOString().slice(0, 10) : '';
        return { date, keptCost: toNum(r['kept_cost']), excludedCost: toNum(r['excluded_cost']) };
      });
    } else {
      logger.warn(`cost-scope: daily query failed: ${dailyResult.reason instanceof Error ? dailyResult.reason.message : String(dailyResult.reason)}`);
    }

    let sampleRows: readonly CostScopeSampleRow[] = [];
    if (sampleResult.status === 'fulfilled') {
      sampleRows = sampleResult.value.map(r => {
        const tags: Record<string, string> = {};
        for (const t of tagColumns) {
          const v = r[t.id];
          tags[t.id] = typeof v === 'string' ? v : '';
        }
        const rawDate = r['usage_date'];
        const date = typeof rawDate === 'string'
          ? rawDate
          : rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : '';
        return {
          date,
          accountId: typeof r['account_id'] === 'string' ? r['account_id'] : '',
          accountName: typeof r['account_name'] === 'string' ? r['account_name'] : '',
          region: typeof r['region'] === 'string' ? r['region'] : '',
          service: typeof r['service'] === 'string' ? r['service'] : '',
          serviceFamily: typeof r['service_family'] === 'string' ? r['service_family'] : '',
          lineItemType: typeof r['line_item_type'] === 'string' ? r['line_item_type'] : '',
          operation: typeof r['operation'] === 'string' ? r['operation'] : '',
          usageType: typeof r['usage_type'] === 'string' ? r['usage_type'] : '',
          description: typeof r['description'] === 'string' ? r['description'] : '',
          resourceId: typeof r['resource_id'] === 'string' ? r['resource_id'] : '',
          usageAmount: toNum(r['usage_amount']),
          cost: toNum(r['cost']),
          listCost: toNum(r['list_cost']),
          excluded: toNum(r['excluded']) === 1,
          tags,
        };
      });
    } else {
      logger.warn(`cost-scope: sample query failed: ${sampleResult.reason instanceof Error ? sampleResult.reason.message : String(sampleResult.reason)}`);
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
      sampleRows,
      sampleTotalRowCount,
      tagColumns,
    };
  });

  ipcMain.handle('cost-scope:get-capabilities', async (): Promise<CostScopeCapabilities> => {
    const cols = await getAvailableColumns('daily');
    return {
      hasEffectiveCostColumns:
        cols.has('reservation_effective_cost') && cols.has('savings_plan_savings_plan_effective_cost'),
      hasBlendedColumn: cols.has('line_item_blended_cost'),
      hasNetColumns: cols.has('line_item_net_unblended_cost'),
    };
  });

  ipcMain.handle('cost-scope:reveal-folder', (): void => {
    shell.showItemInFolder(ctx.costScopePath);
  });
}
