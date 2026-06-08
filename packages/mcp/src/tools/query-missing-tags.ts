import {
  buildMissingTagsQuery,
  buildNonResourceCostQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { truncateRows, truncateFooter } from '../formatters/cost.js';
import type { Cell, Column, StructuredResult, Table } from '../formatters/result.js';
import {
  buildQueryContextOpts,
  defaultDateRange,
  resolveEntityName,
  resolveFormat,
  structuredToolResult,
  toDimensionId,
  toDollars,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
  toolError,
} from './tool-helpers.js';

export async function queryMissingTags(
  ctx: McpContext,
  params: {
    tagDimension: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    minCost?: number | undefined;
    limit?: number | undefined;
    format?: string | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const tagDimension: DimensionId = toDimensionId(params.tagDimension);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const filters = toFilterMap(params.filters);
  const minCost = toDollars(params.minCost ?? 10);
  const limit = params.limit ?? 20;

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return toolError(`No data for ${dateRange.start} to ${dateRange.end}.`);

  const resourceQuery = buildMissingTagsQuery(
    { tagDimension, dateRange, filters, minCost },
    opts,
  );
  const nonResourceQuery = buildNonResourceCostQuery(
    { tagDimension, dateRange, filters, minCost },
    opts,
  );

  logger.info('query-missing-tags', { tagDimension, dateRange });

  const [resourceRows, nonResourceRows] = await Promise.all([
    ctx.runPreparedQuery(resourceQuery.sql, resourceQuery.params),
    ctx.runPreparedQuery(nonResourceQuery.sql, nonResourceQuery.params),
  ]);

  const accountMap = await ctx.getAccountMap();

  let actionableCost = 0;
  let actionableCount = 0;
  let untaggableCost = 0;
  let untaggableCount = 0;

  const items: { accountName: string; resourceId: string; service: string; cost: number; bucket: string }[] = [];

  for (const row of resourceRows) {
    const cost = toNum(row['cost']);
    const bucket = row['bucket'] === 'likely-untaggable' ? 'likely-untaggable' : 'actionable';
    const accountId = toStr(row['account_id']);
    const accountName = resolveEntityName(accountId, accountMap) || toStr(row['account_name']);

    if (bucket === 'actionable') {
      actionableCost += cost;
      actionableCount += 1;
    } else {
      untaggableCost += cost;
      untaggableCount += 1;
    }

    if (cost >= minCost) {
      items.push({
        accountName,
        resourceId: toStr(row['resource_id']),
        service: toStr(row['service']),
        cost,
        bucket,
      });
    }
  }

  let nonResourceCost = 0;
  for (const row of nonResourceRows) {
    nonResourceCost += toNum(row['cost']);
  }

  const actionableItems = items.filter(i => i.bucket === 'actionable').sort((a, b) => b.cost - a.cost);

  const notes: string[] = [];
  const tables: Table[] = [];

  if (actionableItems.length > 0) {
    const columns: Column[] = [
      { key: 'account', header: 'Account' },
      { key: 'service', header: 'Service' },
      { key: 'resource', header: 'Resource' },
      { key: 'cost', header: 'Cost', type: 'currency' },
    ];
    const { visible, hiddenCount, hiddenCost } = truncateRows(actionableItems, limit, i => i.cost);
    const rows: Cell[][] = visible.map(i => [
      i.accountName,
      i.service,
      i.resourceId.length > 40 ? `${i.resourceId.slice(0, 37)}...` : i.resourceId,
      i.cost,
    ]);
    tables.push({
      title: 'Top Actionable Untagged Resources',
      columns,
      rows,
      footer: truncateFooter(hiddenCount, hiddenCost),
    });
  } else {
    notes.push('*No actionable untagged resources above the cost threshold.*');
  }

  const result: StructuredResult = {
    title: `Missing Tags: ${params.tagDimension} (${dateRange.start} to ${dateRange.end})`,
    meta: [
      { label: 'Actionable Resources', value: actionableCount, type: 'number' },
      { label: 'Actionable Cost', value: actionableCost, type: 'currency' },
      { label: 'Likely Untaggable Resources', value: untaggableCount, type: 'number' },
      { label: 'Likely Untaggable Cost', value: untaggableCost, type: 'currency' },
      { label: 'Non-Resource Cost', value: nonResourceCost, type: 'currency' },
    ],
    notes,
    tables,
  };
  return structuredToolResult(result, format);
}
