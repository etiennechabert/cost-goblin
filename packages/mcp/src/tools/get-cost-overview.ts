import {
  asDimensionId,
  buildCostQuery,
  listLocalMonths,
  logger,
} from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult, Table } from '../formatters/result.js';
import {
  buildQueryContextOpts,
  computeDataCoverage,
  defaultDateRange,
  emptyRangeResult,
  getFirstProviderName,
  resolveFormat,
  structuredToolResult,
  toDateRange,
  toNum,
  toStr,
  toolError,
} from './tool-helpers.js';
import type { DateRange, FilterMap } from '@costgoblin/core';

export async function getCostOverview(
  ctx: McpContext,
  params: { dateRange?: { start: string; end: string } | undefined; format?: string | undefined },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();

  const provider = await getFirstProviderName(ctx);
  const months = provider === null ? [] : await listLocalMonths(ctx.dataDir, provider, 'daily');
  if (months.length === 0) {
    return toolError('No data found. Ensure COSTGOBLIN_DATA_DIR points to a directory with synced Parquet data.');
  }

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) {
    return emptyRangeResult(ctx, dateRange, format, `Cost Overview (${dateRange.start} to ${dateRange.end})`);
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

  const svcColumns: Column[] = [
    { key: 'service', header: 'Service' },
    { key: 'cost', header: 'Cost', type: 'currency' },
    { key: 'pct', header: '% of Total', type: 'percent' },
  ];
  const svcRows: Cell[][] = topServices.map(([name, cost]) => [
    name,
    cost,
    serviceTotalCost > 0 ? (cost / serviceTotalCost) * 100 : 0,
  ]);

  const tables: Table[] = [
    { title: 'Top Services', columns: svcColumns, rows: svcRows },
  ];

  if (topAccounts.length > 0) {
    tables.push({
      title: 'Top Accounts',
      columns: [
        { key: 'account', header: 'Account' },
        { key: 'cost', header: 'Cost', type: 'currency' },
      ],
      rows: topAccounts.map(([name, cost]): Cell[] => [name, cost]),
    });
  }

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `Cost Overview (${dateRange.start} to ${dateRange.end})`,
    coverage,
    meta: [
      { label: 'Total Cost', value: serviceTotalCost, type: 'currency' },
      { label: 'Available Dimensions', value: enabledDims.join(', ') },
    ],
    tables,
  };
  return structuredToolResult(result, format);
}
