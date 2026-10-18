import { ipcMain } from 'electron';
import {
  buildTrendQuery,
  logger,
  asEntityRef,
  asDollars,
  previousTrendPeriod,
} from '@costgoblin/core';
import type {
  TrendQueryParams,
  TrendResult,
  QueryContextOptions,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  buildTrendResult,
  columnForDimension,
  filterOrgTree,
  isAccountGroupBy,
  mergeTrendRowsByEntity,
  providersEmptyForRange,
  resolveEntityName,
  resolveRollupSource,
} from './query-utils.js';
import { originStore } from '../query-log.js';

export function registerTrendHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getOrgTreeConfig, getQueryCostScope, getQueryProviders, runPreparedQuery, rollupStore } = app;

  ipcMain.handle('query:trends', (_event, params: TrendQueryParams): Promise<TrendResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getQueryCostScope();
    const providers = await getQueryProviders('daily');
    const empty = providersEmptyForRange(providers, params.dateRange);
    if (empty) return { increases: [], savings: [], totalIncrease: asDollars(0), totalSavings: asDollars(0) };

    // Compute the full date range (current + previous period) to check if
    // the materialized base covers both spans.
    const fullRange = { start: previousTrendPeriod(params.dateRange).start, end: params.dateRange.end };
    // Coverage must include the previous-period span (fullRange), or trends
    // under-reports previous_cost. resolveRollupSource checks every touched month.
    const matSource = resolveRollupSource(rollupStore, providers, fullRange, 'daily', [
      // Filtered dims are WHEREd too — anything not in the grain gates to raw.
      ...Object.keys(params.filters).map(k => columnForDimension(dimensions, k)),
      columnForDimension(dimensions, params.groupBy), 'cost',
    ]);
    const isMat = matSource !== undefined;

    const orgTree = await filterOrgTree(params.filters, dimensions, getOrgTreeConfig);
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, orgTree, costScope, materializedSource: matSource };
    const { sql, params: queryParams } = buildTrendQuery(params, qcOpts);
    logger.info('query:trends', { groupBy: params.groupBy, materialized: isMat });

    const rows = await runPreparedQuery(sql, queryParams, isMat);
    const result = buildTrendResult(rows, params.deltaThreshold, params.percentThreshold);
    if (isAccountGroupBy(params.groupBy)) {
      return {
        ...result,
        increases: mergeTrendRowsByEntity(result.increases.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
        savings: mergeTrendRowsByEntity(result.savings.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
      };
    }
    return result;
  }));
}
