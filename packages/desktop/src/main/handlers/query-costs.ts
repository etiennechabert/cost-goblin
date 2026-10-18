import { ipcMain } from 'electron';
import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildEntityDetailQuery,
  logger,
  asEntityRef,
  asDollars,
} from '@costgoblin/core';
import type {
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  DimensionId,
  DimensionsConfig,
  EntityDetailParams,
  EntityDetailResult,
  OrgNode,
  QueryContextOptions,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  applyOrgTreeRollup,
  buildCostResult,
  buildDailyCostsResult,
  buildEntityDetailResult,
  columnForDimension,
  filterOrgTree,
  isAccountGroupBy,
  isOwnerGroupBy,
  mergeCostRowsByEntity,
  providersEmptyForRange,
  resolveEntityName,
  resolveRollupSource,
  rollupNodeByValue,
} from './query-utils.js';
import { originStore } from '../query-log.js';

export function registerCostHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getOrgTreeConfig, getQueryCostScope, getQueryProviders, runPreparedQuery, rollupStore } = app;

  /** The org tree a query grouped by the owner dimension rolls its values up
   *  through. None when it groups by anything else, when it drills into one
   *  node's values (orgNodeValues), or when no tree is configured. */
  async function rollupTree(
    params: { readonly groupBy: DimensionId; readonly orgNodeValues?: readonly string[] | undefined },
    dimensions: DimensionsConfig,
  ): Promise<readonly OrgNode[] | undefined> {
    if (!isOwnerGroupBy(params.groupBy, dimensions) || params.orgNodeValues !== undefined) return undefined;
    const { tree } = await getOrgTreeConfig();
    return tree.length > 0 ? tree : undefined;
  }

  /** The name a daily series takes, matching query:costs' row for the same
   *  group so the bar and line widgets agree with the pie, treemap and top-N
   *  bar on labels (and the colors keyed by them): an account id becomes its
   *  display name, an owner value the org-tree node it rolls up into, and any
   *  other value stays as is. */
  async function seriesNameFor(params: DailyCostsParams, dimensions: DimensionsConfig): Promise<(group: string) => string> {
    if (isAccountGroupBy(params.groupBy)) {
      const accountMap = await getAccountMap();
      return group => resolveEntityName(group, accountMap);
    }
    const tree = await rollupTree(params, dimensions);
    if (tree === undefined) return group => group;
    const nodeByValue = rollupNodeByValue(tree);
    return group => nodeByValue.get(group) ?? group;
  }

  ipcMain.handle('query:costs', (_event, params: CostQueryParams): Promise<CostResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getQueryCostScope();
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const providers = await getQueryProviders(tier);
    const empty = providersEmptyForRange(providers, params.dateRange);
    if (empty) return { rows: [], totalCost: asDollars(0), topServices: [], dateRange: params.dateRange };
    const matSource = resolveRollupSource(rollupStore, providers, params.dateRange, tier, [
      // Filters are applied in the WHERE too — a filtered dimension missing
      // from the rollup grain (e.g. the injected `provider`) must gate to raw.
      ...Object.keys(params.filters).map(k => columnForDimension(dimensions, k)),
      columnForDimension(dimensions, params.groupBy), 'service', 'cost',
    ]);
    const isMat = matSource !== undefined;
    const orgTree = await filterOrgTree(params.filters, dimensions, getOrgTreeConfig);
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, orgTree, costScope, materializedSource: matSource };
    const { sql, params: queryParams } = buildCostQuery(params, qcOpts);
    logger.info('query:costs', { groupBy: params.groupBy, materialized: isMat });

    const rows = await runPreparedQuery(sql, queryParams, isMat);
    let result = buildCostResult(rows, params.dateRange);

    if (isAccountGroupBy(params.groupBy)) {
      result = {
        ...result,
        rows: mergeCostRowsByEntity(result.rows.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) }))),
      };
    }

    const tree = await rollupTree(params, dimensions);
    if (tree !== undefined) result = applyOrgTreeRollup(result, tree);

    return result;
  }));

  ipcMain.handle('query:daily-costs', (_event, params: DailyCostsParams): Promise<DailyCostsResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getQueryCostScope();
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const providers = await getQueryProviders(tier);
    const empty = providersEmptyForRange(providers, params.dateRange);
    if (empty) return { days: [], groups: [], totalCost: asDollars(0) };
    const matSource = resolveRollupSource(rollupStore, providers, params.dateRange, tier, [
      ...Object.keys(params.filters).map(k => columnForDimension(dimensions, k)),
      columnForDimension(dimensions, params.groupBy), 'cost',
    ]);
    const isMat = matSource !== undefined;
    const orgTree = await filterOrgTree(params.filters, dimensions, getOrgTreeConfig);
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, orgTree, costScope, materializedSource: matSource };
    const { sql, params: queryParams } = buildDailyCostsQuery(params, qcOpts);
    logger.info('query:daily-costs', { groupBy: params.groupBy, materialized: isMat });

    const rows = await runPreparedQuery(sql, queryParams, isMat);
    return buildDailyCostsResult(rows, await seriesNameFor(params, dimensions));
  }));

  ipcMain.handle('query:entity-detail', (_event, params: EntityDetailParams): Promise<EntityDetailResult> => originStore.run(params.origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getQueryCostScope();
    const tier = params.granularity === 'hourly' ? 'hourly' : 'daily';
    const providers = await getQueryProviders(tier);
    const empty = providersEmptyForRange(providers, params.dateRange);
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
    const matSource = resolveRollupSource(rollupStore, providers, params.dateRange, tier, [
      ...Object.keys(params.filters).map(k => columnForDimension(dimensions, k)),
      columnForDimension(dimensions, params.dimension), 'service', 'account_id', 'account_name', 'cost',
    ]);
    const isMat = matSource !== undefined;
    // The entity filters on its own value too (buildEntityDetailQuery): an
    // org-tree node's detail covers the values under it.
    const orgTree = await filterOrgTree(params.filters, dimensions, getOrgTreeConfig)
      ?? await filterOrgTree({ [params.dimension]: [params.entity] }, dimensions, getOrgTreeConfig);
    const qcOpts: QueryContextOptions = { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, orgTree, costScope, materializedSource: matSource };
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
