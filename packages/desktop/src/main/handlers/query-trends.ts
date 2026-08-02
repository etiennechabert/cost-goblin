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
  QueryContextOptions,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  buildTrendResult,
  columnForDimension,
  mergeTrendRowsByEntity,
  resolveAvailablePeriods,
  resolveEntityName,
  resolveRollupSource,
} from './query-utils.js';
import { originStore } from '../query-log.js';

export function registerTrendHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getCostScope, getQueryProviders, runPreparedQuery, rollupStore } = app;

  ipcMain.handle('query:trends', (_event, params: TrendQueryParams): Promise<TrendResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const providers = await getQueryProviders('daily');
    const firstProvider = providers[0];
    const empty = firstProvider === undefined
      || (await resolveAvailablePeriods(ctx.dataDir, firstProvider.name, 'daily', params.dateRange)).empty;
    if (empty) return { increases: [], savings: [], totalIncrease: asDollars(0), totalSavings: asDollars(0) };

    // Compute the full date range (current + previous period) to check if
    // the materialized base covers both spans.
    const dayMs = 86_400_000;
    const startMs = new Date(`${params.dateRange.start}T00:00:00Z`).getTime();
    const endMs = new Date(`${params.dateRange.end}T00:00:00Z`).getTime();
    const durationDays = Math.round((endMs - startMs) / dayMs) + 1;
    const prevStart = new Date(startMs - durationDays * dayMs).toISOString().slice(0, 10);
    const fullRange = { start: prevStart, end: params.dateRange.end };
    // Coverage must include the previous-period span (fullRange), or trends
    // under-reports previous_cost. resolveRollupSource checks every touched month.
    const matSource = resolveRollupSource(rollupStore, fullRange, 'daily', [columnForDimension(dimensions, params.groupBy), 'cost']);
    const isMat = matSource !== undefined;

    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, costScope, materializedSource: matSource };
    const { sql, params: queryParams } = buildTrendQuery(params, qcOpts);
    logger.info('query:trends', { groupBy: params.groupBy, materialized: isMat });

    const rows = await runPreparedQuery(sql, queryParams, isMat);
    const result = buildTrendResult(rows, params.deltaThreshold, params.percentThreshold);
    if (params.groupBy === 'account' || params.groupBy === 'account_id') {
      return {
        ...result,
        increases: mergeTrendRowsByEntity(result.increases.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
        savings: mergeTrendRowsByEntity(result.savings.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
      };
    }
    return result;
  }));
}
