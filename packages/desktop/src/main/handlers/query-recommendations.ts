import { ipcMain } from 'electron';
import {
  buildMissingTagsQuery,
  buildNonResourceCostQuery,
  capToFreshnessLag,
  countSavings,
  loadSavingsRecommendations,
  logger,
  asDollars,
} from '@costgoblin/core';
import type {
  MissingTagsParams,
  MissingTagsResult,
  SavingsResult,
  QueryContextOptions,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  buildMissingTagsResult,
  providersEmptyForRange,
  resolveEntityName,
} from './query-utils.js';
import { originStore } from '../query-log.js';

export function registerRecommendationHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getConfig, getQueryCostScope, getQueryProviders, runQuery, runPreparedQuery } = app;

  ipcMain.handle('query:missing-tags', (_event, params: MissingTagsParams): Promise<MissingTagsResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getQueryCostScope();
    logger.info('query:missing-tags', { tagDimension: params.tagDimension });

    const providers = await getQueryProviders('daily');
    const dateRange = capToFreshnessLag(params.dateRange, ctx.now(), costScope.lagDays);
    if (dateRange === null || providersEmptyForRange(providers, dateRange)) {
      return {
        rows: [],
        totalRows: 0,
        totalActionableCost: asDollars(0),
        totalLikelyUntaggableCost: asDollars(0),
        totalNonResourceCost: asDollars(0),
        actionableCount: 0,
        likelyUntaggableCount: 0,
        unfilteredActionableCount: 0,
        unfilteredActionableCost: asDollars(0),
        unfilteredLikelyUntaggableCount: 0,
        unfilteredLikelyUntaggableCost: asDollars(0),
        nonResourceRows: [],
      };
    }
    // missing-tags / non-resource-cost reference resource_id, line_item_type and
    // raw tags — none in the rollup grain — so they always query raw.
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, costScope, materializedSource: undefined };
    const resourceQuery = buildMissingTagsQuery({ ...params, dateRange }, qcOpts);
    const nonResourceQuery = buildNonResourceCostQuery({ ...params, dateRange }, qcOpts);
    const [resourceRows, nonResourceRows] = await Promise.all([
      runPreparedQuery(resourceQuery.sql, resourceQuery.params, false),
      runPreparedQuery(nonResourceQuery.sql, nonResourceQuery.params, false),
    ]);
    const result = buildMissingTagsResult(resourceRows, nonResourceRows, Number(params.minCost));
    return {
      ...result,
      rows: result.rows.map(r => ({
        ...r,
        accountName: resolveEntityName(r.accountId, accountMap) || r.accountName,
      })),
    };
  }));

  ipcMain.handle('query:savings', (): Promise<SavingsResult> => originStore.run('savings', async () => {
    const config = await getConfig();
    // Each provider's latest Cost Optimization Hub snapshot only: an older
    // day still lists what has since been implemented or superseded.
    const { recommendations, snapshots } = await loadSavingsRecommendations(ctx.dataDir, config.providers, runQuery);
    return { recommendations, snapshots, totalMonthlySavings: countSavings(recommendations).totalMonthlySavings };
  }));
}
