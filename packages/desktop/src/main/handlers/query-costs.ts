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
  QueryContextOptions,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  applyOrgTreeRollup,
  buildCostResult,
  buildEntityDetailResult,
  columnForDimension,
  isOwnerGroupBy,
  mergeCostRowsByEntity,
  resolveAvailablePeriods,
  resolveEntityName,
  resolveRollupSource,
} from './query-utils.js';
import { originStore } from '../query-log.js';

function toDailyCostDay([date, breakdown]: readonly [string, Record<string, number>]): DailyCostDay {
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  const typedBreakdown: Record<string, Dollars> = {};
  for (const [k, v] of Object.entries(breakdown)) {
    typedBreakdown[k] = asDollars(v);
  }
  return { date: asDateString(date), total: asDollars(total), breakdown: typedBreakdown };
}

export function registerCostHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getOrgTreeConfig, getCostScope, getQueryProviders, runPreparedQuery, rollupStore } = app;

  ipcMain.handle('query:costs', (_event, params: CostQueryParams): Promise<CostResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const providers = await getQueryProviders(tier);
    const firstProvider = providers[0];
    const empty = firstProvider === undefined
      || (await resolveAvailablePeriods(ctx.dataDir, firstProvider.name, tier, params.dateRange)).empty;
    if (empty) return { rows: [], totalCost: asDollars(0), topServices: [], dateRange: params.dateRange };
    const matSource = resolveRollupSource(rollupStore, params.dateRange, tier, [columnForDimension(dimensions, params.groupBy), 'service', 'cost']);
    const isMat = matSource !== undefined;
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, costScope, materializedSource: matSource };
    const { sql, params: queryParams } = buildCostQuery(params, qcOpts);
    logger.info('query:costs', { groupBy: params.groupBy, materialized: isMat });

    const rows = await runPreparedQuery(sql, queryParams, isMat);
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
  }));

  ipcMain.handle('query:daily-costs', (_event, params: DailyCostsParams): Promise<DailyCostsResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const providers = await getQueryProviders(tier);
    const firstProvider = providers[0];
    const empty = firstProvider === undefined
      || (await resolveAvailablePeriods(ctx.dataDir, firstProvider.name, tier, params.dateRange)).empty;
    if (empty) return { days: [], groups: [], totalCost: asDollars(0) };
    const matSource = resolveRollupSource(rollupStore, params.dateRange, tier, [columnForDimension(dimensions, params.groupBy), 'cost']);
    const isMat = matSource !== undefined;
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, costScope, materializedSource: matSource };
    const { sql, params: queryParams } = buildDailyCostsQuery(params, qcOpts);
    logger.info('query:daily-costs', { groupBy: params.groupBy, materialized: isMat });

    const rows = await runPreparedQuery(sql, queryParams, isMat);

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
      .map(toDailyCostDay);

    return { days, groups: [...groupSet], totalCost: asDollars(totalCost) };
  }));

  ipcMain.handle('query:entity-detail', (_event, params: EntityDetailParams): Promise<EntityDetailResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const providers = await getQueryProviders(tier);
    const firstProvider = providers[0];
    const empty = firstProvider === undefined
      || (await resolveAvailablePeriods(ctx.dataDir, firstProvider.name, tier, params.dateRange)).empty;
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
    const matSource = resolveRollupSource(rollupStore, params.dateRange, tier, [columnForDimension(dimensions, params.dimension), 'service', 'account_id', 'account_name', 'cost']);
    const isMat = matSource !== undefined;
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, costScope, materializedSource: matSource };
    const { sql, params: queryParams } = buildEntityDetailQuery(params, qcOpts);
    logger.info('query:entity-detail', { entity: params.entity, materialized: isMat });

    const rows = await runPreparedQuery(sql, queryParams, isMat);
    const result = buildEntityDetailResult(rows, params.entity);
    return {
      ...result,
      byAccount: result.byAccount.map(s => ({
        ...s,
        name: resolveEntityName(s.name, accountMap),
      })),
    };
  }));
}
