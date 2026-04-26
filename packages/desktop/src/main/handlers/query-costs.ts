import { ipcMain } from 'electron';
import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildEntityDetailQuery,
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
  EntityDetailParams,
  EntityDetailResult,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  applyOrgTreeRollup,
  buildAccountReverseMap,
  buildCostResult,
  buildEntityDetailResult,
  isOwnerGroupBy,
  mergeCostRowsByEntity,
  resolveAvailablePeriods,
  resolveEntityName,
} from './query-utils.js';

export function registerCostHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getOrgAccountsPath, getOrgTreeConfig, getCostScope, getAvailableColumns, runPreparedQuery, materializedBase } = app;

  ipcMain.handle('query:costs', async (_event, params: CostQueryParams): Promise<CostResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = buildAccountReverseMap(accountMap);
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const availableColumns = await getAvailableColumns(tier);
    const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, tier, params.dateRange);
    if (empty) return { rows: [], totalCost: asDollars(0), topServices: [], dateRange: params.dateRange };
    const matSource = materializedBase.getSource(params.dateRange, tier);
    const { sql, params: queryParams } = buildCostQuery(params, ctx.dataDir, dimensions, undefined, orgPath, available, accountReverseMap, costScope, availableColumns, matSource);
    logger.info('query:costs', { groupBy: params.groupBy, materialized: matSource !== undefined });

    const rows = await runPreparedQuery(sql, queryParams);
    let result = buildCostResult(rows, params.dateRange);

    if (params.groupBy === 'account' || params.groupBy === 'account_id') {
      result = {
        ...result,
        rows: mergeCostRowsByEntity(result.rows.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
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
    const accountMap = await getAccountMap();
    const accountReverseMap = buildAccountReverseMap(accountMap);
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const availableColumns = await getAvailableColumns(tier);
    const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, tier, params.dateRange);
    if (empty) return { days: [], groups: [], totalCost: asDollars(0) };
    const matSource = materializedBase.getSource(params.dateRange, tier);
    const { sql, params: queryParams } = buildDailyCostsQuery(params, ctx.dataDir, dimensions, orgPath, available, accountReverseMap, costScope, availableColumns, matSource);
    logger.info('query:daily-costs', { groupBy: params.groupBy, materialized: matSource !== undefined });

    const rows = await runPreparedQuery(sql, queryParams);

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
      if (existing === undefined) {
        dayMap.set(date, { [group]: cost });
      } else {
        existing[group] = (existing[group] ?? 0) + cost;
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

  ipcMain.handle('query:entity-detail', async (_event, params: EntityDetailParams): Promise<EntityDetailResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = buildAccountReverseMap(accountMap);
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const availableColumns = await getAvailableColumns(tier);
    const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, tier, params.dateRange);
    if (empty) {
      return {
        entity: params.entity,
        totalCost: asDollars(0),
        previousCost: asDollars(0),
        percentChange: 0,
        dailyCosts: [],
        byAccount: [],
        byService: [],
        bySubEntity: [],
      };
    }
    const matSource = materializedBase.getSource(params.dateRange, tier);
    const { sql, params: queryParams } = buildEntityDetailQuery(params, ctx.dataDir, dimensions, orgPath, available, accountReverseMap, costScope, availableColumns, matSource);
    logger.info('query:entity-detail', { entity: params.entity, materialized: matSource !== undefined });

    const rows = await runPreparedQuery(sql, queryParams);
    const result = buildEntityDetailResult(rows, params.entity);
    return {
      ...result,
      byAccount: result.byAccount.map(s => ({
        ...s,
        name: resolveEntityName(s.name, accountMap),
      })),
    };
  });
}
