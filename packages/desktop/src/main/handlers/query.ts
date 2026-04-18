import { ipcMain } from 'electron';
import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildTrendQuery,
  buildMissingTagsQuery,
  buildNonResourceCostQuery,
  buildEntityDetailQuery,
  buildSource,
  buildAliasSqlCase,
  logger,
  asEntityRef,
  asDollars,
  asDateString,
} from '@costgoblin/core';
import type {
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  DailyCostDay,
  Dollars,
  TrendQueryParams,
  TrendResult,
  MissingTagsParams,
  MissingTagsResult,
  EntityDetailParams,
  EntityDetailResult,
  SavingsResult,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import type { RawRow } from '../duckdb-client.js';
import {
  applyOrgTreeRollup,
  buildCostResult,
  buildEntityDetailResult,
  buildMissingTagsResult,
  buildTrendResult,
  isOwnerGroupBy,
  resolveEntityName,
  toEffort,
  toNum,
  toStr,
} from './query-utils.js';

export function registerQueryHandlers(app: AppContext): void {
  const { ctx, getDimensions, getAccountMap, getOrgAccountsPath, getOrgTreeConfig, getConfig, runQuery } = app;

  ipcMain.handle('query:costs', async (_event, params: CostQueryParams): Promise<CostResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const orgPath = await getOrgAccountsPath();
    const sql = buildCostQuery(params, ctx.dataDir, dimensions, undefined, orgPath);
    logger.info('query:costs', { groupBy: params.groupBy });

    const rows = await runQuery(sql);
    let result = buildCostResult(rows, params.dateRange);

    if (params.groupBy === 'account' || params.groupBy === 'account_id') {
      result = {
        ...result,
        rows: result.rows.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) })),
      };
    }

    if (isOwnerGroupBy(params.groupBy, dimensions) && params.orgNodeValues === undefined) {
      const orgTreeConfig = await getOrgTreeConfig();
      if (orgTreeConfig.tree.length > 0) {
        result = applyOrgTreeRollup(result, orgTreeConfig.tree);
      }
    }

    return result;
  });

  ipcMain.handle('query:daily-costs', async (_event, params: DailyCostsParams): Promise<DailyCostsResult> => {
    const dimensions = await getDimensions();
    const orgPath = await getOrgAccountsPath();
    const sql = buildDailyCostsQuery(params, ctx.dataDir, dimensions, orgPath);
    logger.info('query:daily-costs', { groupBy: params.groupBy });

    const rows = await runQuery(sql);

    const dayMap = new Map<string, Record<string, number>>();
    const groupSet = new Set<string>();
    let totalCost = 0;

    for (const row of rows) {
      const rawDate = row['date'];
      const rawGroup = row['group_name'];
      let date: string;
      if (rawDate instanceof Date) {
        date = rawDate.toISOString().slice(0, 10);
      } else if (typeof rawDate === 'string') {
        date = rawDate;
      } else {
        date = '';
      }
      const group = typeof rawGroup === 'string' ? rawGroup : '';
      const cost = Number(row['cost'] ?? 0);

      groupSet.add(group);
      totalCost += cost;

      const existing = dayMap.get(date);
      if (existing !== undefined) {
        existing[group] = (existing[group] ?? 0) + cost;
      } else {
        dayMap.set(date, { [group]: cost });
      }
    }

    const days: DailyCostDay[] = [...dayMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, breakdown]) => {
        const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
        const typedBreakdown: Record<string, Dollars> = {};
        for (const [k, v] of Object.entries(breakdown)) {
          typedBreakdown[k] = asDollars(v);
        }
        return { date: asDateString(date), total: asDollars(total), breakdown: typedBreakdown };
      });

    return { days, groups: [...groupSet], totalCost: asDollars(totalCost) };
  });

  ipcMain.handle('query:trends', async (_event, params: TrendQueryParams): Promise<TrendResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const orgPath = await getOrgAccountsPath();
    const sql = buildTrendQuery(params, ctx.dataDir, dimensions, orgPath);
    logger.info('query:trends', { groupBy: params.groupBy });

    const rows = await runQuery(sql);
    const result = buildTrendResult(rows, params.deltaThreshold, params.percentThreshold);
    if (params.groupBy === 'account' || params.groupBy === 'account_id') {
      return {
        ...result,
        increases: result.increases.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) })),
        savings: result.savings.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) })),
      };
    }
    return result;
  });

  ipcMain.handle('query:missing-tags', async (_event, params: MissingTagsParams): Promise<MissingTagsResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const orgPath = await getOrgAccountsPath();
    logger.info('query:missing-tags', { tagDimension: params.tagDimension });

    const resourceSql = buildMissingTagsQuery(params, ctx.dataDir, dimensions, orgPath);
    const nonResourceSql = buildNonResourceCostQuery(params, ctx.dataDir, dimensions, orgPath);
    const [resourceRows, nonResourceRows] = await Promise.all([
      runQuery(resourceSql),
      runQuery(nonResourceSql),
    ]);
    const result = buildMissingTagsResult(resourceRows, nonResourceRows);
    return {
      ...result,
      rows: result.rows.map(r => ({
        ...r,
        accountName: resolveEntityName(r.accountId, accountMap) || r.accountName,
      })),
    };
  });

  ipcMain.handle('query:savings', async (): Promise<SavingsResult> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider?.sync.costOptimization === undefined) {
      return { recommendations: [], totalMonthlySavings: asDollars(0) };
    }

    let rows: RawRow[];
    try {
      rows = await runQuery(`
        SELECT
          account_id,
          account_name,
          action_type,
          current_resource_type,
          COALESCE(recommended_resource_summary, '') AS summary,
          COALESCE(region, '') AS region,
          COALESCE(estimated_monthly_savings_after_discount, 0) AS monthly_savings,
          COALESCE(estimated_monthly_cost_after_discount, 0) AS monthly_cost,
          COALESCE(estimated_savings_percentage_after_discount, 0) AS savings_pct,
          COALESCE(implementation_effort, '') AS effort,
          COALESCE(resource_arn, '') AS resource_arn,
          COALESCE(current_resource_details, '') AS current_details,
          COALESCE(recommended_resource_details, '') AS recommended_details,
          COALESCE(current_resource_summary, '') AS current_summary,
          COALESCE(restart_needed, false) AS restart_needed,
          COALESCE(rollback_possible, false) AS rollback_possible,
          COALESCE(recommendation_source, '') AS recommendation_source
        FROM read_parquet('${ctx.dataDir}/aws/raw/cost-opt-*/*.parquet', filename=true)
        QUALIFY ROW_NUMBER() OVER (PARTITION BY recommendation_id ORDER BY filename DESC) = 1
        ORDER BY monthly_savings DESC
      `);
    } catch {
      return { recommendations: [], totalMonthlySavings: asDollars(0) };
    }

    let totalSavings = 0;
    const recommendations = rows.map(r => {
      const savings = toNum(r['monthly_savings']);
      totalSavings += savings;
      return {
        accountId: toStr(r['account_id']),
        accountName: toStr(r['account_name']),
        actionType: toStr(r['action_type']),
        resourceType: toStr(r['current_resource_type']),
        summary: toStr(r['summary']),
        region: toStr(r['region']),
        monthlySavings: asDollars(savings),
        monthlyCost: asDollars(toNum(r['monthly_cost'])),
        savingsPercentage: toNum(r['savings_pct']),
        effort: toEffort(toStr(r['effort'])),
        resourceArn: toStr(r['resource_arn']),
        currentDetails: toStr(r['current_details']),
        recommendedDetails: toStr(r['recommended_details']),
        currentSummary: toStr(r['current_summary']),
        restartNeeded: Boolean(r['restart_needed']),
        rollbackPossible: Boolean(r['rollback_possible']),
        recommendationSource: toStr(r['recommendation_source']),
      };
    });

    return { recommendations, totalMonthlySavings: asDollars(totalSavings) };
  });

  ipcMain.handle('query:entity-detail', async (_event, params: EntityDetailParams): Promise<EntityDetailResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const orgPath = await getOrgAccountsPath();
    const sql = buildEntityDetailQuery(params, ctx.dataDir, dimensions, orgPath);
    logger.info('query:entity-detail', { entity: params.entity });

    const rows = await runQuery(sql);
    const result = buildEntityDetailResult(rows, params.entity);
    return {
      ...result,
      byAccount: result.byAccount.map(s => ({
        ...s,
        name: resolveEntityName(s.name, accountMap),
      })),
    };
  });

  ipcMain.handle('query:filter-values', async (_event, dimensionId: string, filterEntries: Record<string, string>, dateRange?: { start: string; end: string }): Promise<{ value: string; label: string; count: number }[]> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();

    const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
    const tag = dimensions.tags.find(d => `tag_${d.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === dimensionId);

    const field = builtIn === undefined ? dimensionId : builtIn.field;
    let fieldExpr = field;
    if (tag !== undefined) {
      fieldExpr = buildAliasSqlCase(field, tag);
    }

    const whereClauses: string[] = [];
    for (const [key, value] of Object.entries(filterEntries)) {
      const fb = dimensions.builtIn.find(d => d.name === key);
      const ft = dimensions.tags.find(d => `tag_${d.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === key);
      const ff = fb === undefined ? key : fb.field;
      let ffExpr = ff;
      if (ft !== undefined) {
        ffExpr = buildAliasSqlCase(ff, ft);
      }
      whereClauses.push(`${ffExpr} = '${value.replaceAll("'", "''")}'`);
    }

    if (dateRange !== undefined) {
      whereClauses.push(`usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const orgPath = await getOrgAccountsPath();
    const source = buildSource(ctx.dataDir, 'daily', dimensions, orgPath);
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
    return rows.map(r => {
      const rawVal = toStr(r['val']);
      const isAccountDim = dimensionId === 'account' || dimensionId === 'account_id';
      const label = isAccountDim ? (accountMap.get(rawVal) ?? rawVal) : rawVal;
      return { value: rawVal, label, count: toNum(r['total_cost']) };
    });
  });
}
