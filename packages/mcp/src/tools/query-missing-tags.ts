import {
  buildMissingTagsQuery,
  buildNonResourceCostQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars } from '../formatters/cost.js';
import { truncateRows, truncateFooter } from '../formatters/cost.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import {
  buildQueryContextOpts,
  defaultDateRange,
  resolveEntityName,
  toDimensionId,
  toDollars,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';

export async function queryMissingTags(
  ctx: McpContext,
  params: {
    tagDimension: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    minCost?: number | undefined;
    limit?: number | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
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

  const sections: string[] = [];
  sections.push(`## Missing Tags: ${params.tagDimension} (${dateRange.start} to ${dateRange.end})`);
  sections.push('');
  sections.push(`**Actionable**: ${String(actionableCount)} resources, ${formatDollars(actionableCost)}`);
  sections.push(`**Likely Untaggable**: ${String(untaggableCount)} resources, ${formatDollars(untaggableCost)}`);
  sections.push(`**Non-Resource Cost**: ${formatDollars(nonResourceCost)} (tax, support, credits, etc.)`);
  sections.push('');

  const actionableItems = items.filter(i => i.bucket === 'actionable').sort((a, b) => b.cost - a.cost);

  if (actionableItems.length > 0) {
    sections.push('### Top Actionable Untagged Resources');
    sections.push('');
    const columns: ColumnDef[] = [
      { header: 'Account' },
      { header: 'Service' },
      { header: 'Resource' },
      { header: 'Cost', align: 'right' },
    ];
    const { visible, hiddenCount, hiddenCost } = truncateRows(actionableItems, limit, i => i.cost);
    const tableRows = visible.map(i => [
      i.accountName,
      i.service,
      i.resourceId.length > 40 ? `${i.resourceId.slice(0, 37)}...` : i.resourceId,
      formatDollars(i.cost),
    ]);
    sections.push(markdownTable(columns, tableRows));
    sections.push(truncateFooter(hiddenCount, hiddenCost));
  } else {
    sections.push('*No actionable untagged resources above the cost threshold.*');
  }

  return toolResult(sections.join('\n'));
}
