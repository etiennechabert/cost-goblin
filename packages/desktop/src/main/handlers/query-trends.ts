import { ipcMain } from 'electron';
import {
  buildTrendQuery,
  logger,
  asEntityRef,
  asDollars,
} from '@costgoblin/core';
import type {
  TrendQueryParams,
  TrendResult,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  buildAccountReverseMap,
  buildTrendResult,
  mergeTrendRowsByEntity,
  resolveAvailablePeriods,
  resolveEntityName,
} from './query-utils.js';

export function registerTrendHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getOrgAccountsPath, getCostScope, getAvailableColumns, runPreparedQuery } = app;

  ipcMain.handle('query:trends', async (_event, params: TrendQueryParams): Promise<TrendResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = buildAccountReverseMap(accountMap);
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const availableColumns = await getAvailableColumns('daily');
    const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, 'daily', params.dateRange);
    if (empty) return { increases: [], savings: [], totalIncrease: asDollars(0), totalSavings: asDollars(0) };
    const { sql, params: queryParams } = buildTrendQuery(params, ctx.dataDir, dimensions, orgPath, available, accountReverseMap, costScope, availableColumns);
    logger.info('query:trends', { groupBy: params.groupBy });

    const rows = await runPreparedQuery(sql, queryParams);
    const result = buildTrendResult(rows, params.deltaThreshold, params.percentThreshold);
    if (params.groupBy === 'account' || params.groupBy === 'account_id') {
      return {
        ...result,
        increases: mergeTrendRowsByEntity(result.increases.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
        savings: mergeTrendRowsByEntity(result.savings.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
      };
    }
    return result;
  });
}
