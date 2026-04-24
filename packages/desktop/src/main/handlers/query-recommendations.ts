import { ipcMain } from 'electron';
import {
  buildMissingTagsQuery,
  buildNonResourceCostQuery,
  logger,
  asDollars,
} from '@costgoblin/core';
import type {
  MissingTagsParams,
  MissingTagsResult,
  SavingsResult,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  buildAccountReverseMap,
  buildMissingTagsResult,
  resolveAvailablePeriods,
  resolveEntityName,
  toEffort,
  toNum,
  toStr,
} from './query-utils.js';

export function registerRecommendationHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getOrgAccountsPath, getConfig, getCostScope, getAvailableColumns, runQuery, runPreparedQuery } = app;

  ipcMain.handle('query:missing-tags', async (_event, params: MissingTagsParams): Promise<MissingTagsResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = buildAccountReverseMap(accountMap);
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const availableColumns = await getAvailableColumns('daily');
    logger.info('query:missing-tags', { tagDimension: params.tagDimension });

    const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, 'daily', params.dateRange);
    if (empty) {
      return {
        rows: [],
        totalActionableCost: asDollars(0),
        totalLikelyUntaggableCost: asDollars(0),
        totalNonResourceCost: asDollars(0),
        actionableCount: 0,
        likelyUntaggableCount: 0,
        nonResourceRows: [],
      };
    }
    const resourceQuery = buildMissingTagsQuery(params, ctx.dataDir, dimensions, orgPath, available, accountReverseMap, costScope, availableColumns);
    const nonResourceQuery = buildNonResourceCostQuery(params, ctx.dataDir, dimensions, orgPath, available, accountReverseMap, costScope, availableColumns);
    const [resourceRows, nonResourceRows] = await Promise.all([
      runPreparedQuery(resourceQuery.sql, resourceQuery.params),
      runPreparedQuery(nonResourceQuery.sql, nonResourceQuery.params),
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

    let rows: import('../duckdb-client.js').RawRow[];
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
}
