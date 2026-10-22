import {
  asDimensionId,
  buildCostQuery,
  logger,
} from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { truncateFooter, truncateRows } from '../formatters/cost.js';
import type { Cell, Column, StructuredResult, Table } from '../formatters/result.js';
import {
  buildQueryContextOpts,
  computeDataCoverage,
  emptyRangeResult,
  getQueryProviders,
  resolveEntityName,
  resolveFormat,
  resolveToolDateRange,
  structuredToolResult,
  toNum,
  toolError,
  toStr,
  withinLagResult,
} from './tool-helpers.js';
import type { FilterMap } from '@costgoblin/core';

/** Each entity's total cost, summed per `nameOf(entity)`. buildCostQuery
 *  returns one row per (entity, top service) and repeats the entity's total on
 *  each of them, so only an entity's first row counts. A NULL entity and a ''
 *  one are separate groups that read alike, so both count, summed under ''. */
function totalsByName(rows: readonly RawRow[], nameOf: (entity: string) => string): [string, number][] {
  const seen = new Set<string | null>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const raw = row['entity'];
    const key = raw === null || raw === undefined ? null : toStr(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = nameOf(toStr(raw));
    totals.set(name, (totals.get(name) ?? 0) + toNum(row['total_cost']));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

export async function getCostOverview(
  ctx: McpContext,
  params: { dateRange?: { start: string; end: string } | undefined; format?: string | undefined },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const range = await resolveToolDateRange(ctx, params.dateRange);
  if (range.kind === 'within-lag') return withinLagResult(ctx, range, format, 'Cost Overview');
  const { dateRange, cappedAt } = range;

  const allProviders = await getQueryProviders(ctx, 'daily');
  const anyData = allProviders.some(p => (p.availablePeriods ?? []).length > 0);
  if (!anyData) {
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

  // The cost query returns every service, so the total covers the ones past
  // the ten listed too.
  const services = totalsByName(serviceRows, entity => entity);
  const totalCost = services.reduce((sum, [, cost]) => sum + cost, 0);
  const shownServices = truncateRows(services, 10, ([, cost]) => cost);

  const accountMap = await ctx.getAccountMap();
  const accounts = totalsByName(accountRows, entity => resolveEntityName(entity, accountMap));
  const shownAccounts = truncateRows(accounts, 5, ([, cost]) => cost);

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
  const svcRows: Cell[][] = shownServices.visible.map(([name, cost]) => [
    name,
    cost,
    totalCost > 0 ? (cost / totalCost) * 100 : 0,
  ]);

  const tables: Table[] = [
    {
      title: 'Top Services',
      columns: svcColumns,
      rows: svcRows,
      footer: truncateFooter(shownServices.hiddenCount, shownServices.hiddenCost),
    },
  ];

  if (accounts.length > 0) {
    tables.push({
      title: 'Top Accounts',
      columns: [
        { key: 'account', header: 'Account' },
        { key: 'cost', header: 'Cost', type: 'currency' },
      ],
      rows: shownAccounts.visible.map(([name, cost]): Cell[] => [name, cost]),
      footer: truncateFooter(shownAccounts.hiddenCount, shownAccounts.hiddenCost),
    });
  }

  const coverage = await computeDataCoverage(ctx, dateRange, cappedAt);
  const result: StructuredResult = {
    title: `Cost Overview (${dateRange.start} to ${dateRange.end})`,
    coverage,
    meta: [
      { label: 'Total Cost', value: totalCost, type: 'currency' },
      { label: 'Available Dimensions', value: enabledDims.join(', ') },
    ],
    tables,
  };
  return structuredToolResult(result, format);
}
