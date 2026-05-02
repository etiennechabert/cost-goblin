import {
  asDimensionId,
  buildCostQuery,
  listLocalMonths,
  logger,
} from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars } from '../formatters/cost.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import {
  buildQueryContextOpts,
  defaultDateRange,
  toDateRange,
  toNum,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';
import type { DateRange, FilterMap } from '@costgoblin/core';

export async function getCostOverview(
  ctx: McpContext,
  params: { dateRange?: { start: string; end: string } | undefined },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();

  const months = await listLocalMonths(ctx.dataDir, 'daily');
  if (months.length === 0) {
    return toolError('No data found. Ensure COSTGOBLIN_DATA_DIR points to a directory with synced Parquet data.');
  }

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) {
    return toolError(`No data available for the period ${dateRange.start} to ${dateRange.end}. Available months: ${months.join(', ')}`);
  }

  const emptyFilters: FilterMap = {};

  const serviceQuery = buildCostQuery(
    { groupBy: asDimensionId('service'), dateRange, filters: emptyFilters },
    opts,
    10,
  );
  const accountQuery = buildCostQuery(
    { groupBy: asDimensionId('account'), dateRange, filters: emptyFilters },
    opts,
    5,
  );

  logger.info('get-cost-overview', { dateRange });

  const [serviceRows, accountRows] = await Promise.all([
    ctx.runPreparedQuery(serviceQuery.sql, serviceQuery.params),
    ctx.runPreparedQuery(accountQuery.sql, accountQuery.params),
  ]);

  const serviceMap = new Map<string, number>();
  for (const row of serviceRows) {
    const entity = toStr(row['entity']);
    const cost = toNum(row['total_cost']);
    if (!serviceMap.has(entity)) serviceMap.set(entity, cost);
  }
  const topServices = [...serviceMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const serviceTotalCost = topServices.reduce((sum, [, cost]) => sum + cost, 0);

  const accountMap = await ctx.getAccountMap();
  const accountCosts = new Map<string, number>();
  for (const row of accountRows) {
    const entity = toStr(row['entity']);
    const cost = toNum(row['total_cost']);
    const name = accountMap.get(entity) ?? entity;
    accountCosts.set(name, (accountCosts.get(name) ?? 0) + cost);
  }
  const topAccounts = [...accountCosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const dimensions = await ctx.getDimensions();
  const enabledDims = [
    ...dimensions.builtIn.filter(d => d.enabled !== false).map(d => d.name),
    ...dimensions.tags.filter(d => d.enabled !== false).map(d => d.label),
  ];

  const sections: string[] = [];
  sections.push(`## Cost Overview (${dateRange.start} to ${dateRange.end})`);
  sections.push('');
  sections.push(`**Total Cost**: ${formatDollars(serviceTotalCost)}`);
  sections.push(`**Data Range**: ${months[0] ?? '?'} to ${months[months.length - 1] ?? '?'}`);
  sections.push(`**Available Dimensions**: ${enabledDims.join(', ')}`);

  sections.push('');
  sections.push('### Top Services');
  const svcCols: ColumnDef[] = [
    { header: 'Service' },
    { header: 'Cost', align: 'right' },
    { header: '% of Total', align: 'right' },
  ];
  const svcRows = topServices.map(([name, cost]) => [
    name,
    formatDollars(cost),
    serviceTotalCost > 0 ? `${((cost / serviceTotalCost) * 100).toFixed(1)}%` : '0%',
  ]);
  sections.push(markdownTable(svcCols, svcRows));

  if (topAccounts.length > 0) {
    sections.push('');
    sections.push('### Top Accounts');
    const acctCols: ColumnDef[] = [
      { header: 'Account' },
      { header: 'Cost', align: 'right' },
    ];
    const acctRows = topAccounts.map(([name, cost]) => [name, formatDollars(cost)]);
    sections.push(markdownTable(acctCols, acctRows));
  }

  return toolResult(sections.join('\n'));
}
