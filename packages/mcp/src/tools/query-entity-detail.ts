import {
  asEntityRef,
  buildEntityDetailQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId, EntityRef } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars } from '../formatters/cost.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import {
  buildQueryContextOpts,
  defaultDateRange,
  lookupDimension,
  resolveEntityName,
  toDimensionId,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';

export async function queryEntityDetail(
  ctx: McpContext,
  params: {
    entity: string;
    dimension: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const entity: EntityRef = asEntityRef(params.entity);
  const dimension: DimensionId = toDimensionId(params.dimension);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const filters = toFilterMap(params.filters);

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return toolError(`No data for ${dateRange.start} to ${dateRange.end}.`);

  const { sql, params: queryParams } = buildEntityDetailQuery(
    { entity, dimension, dateRange, filters },
    opts,
  );
  logger.info('query-entity-detail', { entity, dimension, dateRange });
  const rows = await ctx.runPreparedQuery(sql, queryParams);

  const accountMap = await ctx.getAccountMap();

  const dailyMap = new Map<string, { cost: number; byService: Record<string, number>; byAccount: Record<string, number> }>();
  const serviceMap = new Map<string, number>();
  const accountCostMap = new Map<string, number>();
  let totalCost = 0;

  for (const row of rows) {
    const date = toStr(row['usage_date']);
    const service = toStr(row['service']);
    const accountId = toStr(row['account_id']);
    const cost = toNum(row['cost']);
    totalCost += cost;

    if (!dailyMap.has(date)) {
      dailyMap.set(date, { cost: 0, byService: {}, byAccount: {} });
    }
    const day = dailyMap.get(date);
    if (day !== undefined) {
      day.cost += cost;
      day.byService[service] = (day.byService[service] ?? 0) + cost;
      day.byAccount[accountId] = (day.byAccount[accountId] ?? 0) + cost;
    }
    serviceMap.set(service, (serviceMap.get(service) ?? 0) + cost);
    accountCostMap.set(accountId, (accountCostMap.get(accountId) ?? 0) + cost);
  }

  const { label: dimLabel } = lookupDimension(dimension, opts.dimensions);

  const sections: string[] = [];
  sections.push(`## ${params.entity} (${dimLabel})`);
  sections.push(`**Period**: ${dateRange.start} to ${dateRange.end}`);
  sections.push(`**Total Cost**: ${formatDollars(totalCost)}`);
  sections.push('');

  const svcSlices = [...serviceMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (svcSlices.length > 0) {
    sections.push('### Service Breakdown');
    const svcCols: ColumnDef[] = [
      { header: 'Service' },
      { header: 'Cost', align: 'right' },
      { header: '% Total', align: 'right' },
    ];
    const svcRows = svcSlices.map(([name, cost]) => [
      name,
      formatDollars(cost),
      totalCost > 0 ? `${((cost / totalCost) * 100).toFixed(1)}%` : '0%',
    ]);
    sections.push(markdownTable(svcCols, svcRows));
    sections.push('');
  }

  const acctSlices = [...accountCostMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (acctSlices.length > 1) {
    sections.push('### Account Breakdown');
    const acctCols: ColumnDef[] = [
      { header: 'Account' },
      { header: 'Cost', align: 'right' },
      { header: '% Total', align: 'right' },
    ];
    const acctRows = acctSlices.map(([id, cost]) => [
      resolveEntityName(id, accountMap),
      formatDollars(cost),
      totalCost > 0 ? `${((cost / totalCost) * 100).toFixed(1)}%` : '0%',
    ]);
    sections.push(markdownTable(acctCols, acctRows));
    sections.push('');
  }

  const sortedDays = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sortedDays.length > 0 && sortedDays.length <= 31) {
    sections.push('### Daily Trend');
    const dailyCols: ColumnDef[] = [
      { header: 'Date' },
      { header: 'Cost', align: 'right' },
    ];
    const dailyRows = sortedDays.map(([date, data]) => [date, formatDollars(data.cost)]);
    sections.push(markdownTable(dailyCols, dailyRows));
  } else if (sortedDays.length > 31) {
    const weekMap = new Map<string, number>();
    for (const [date, data] of sortedDays) {
      const d = new Date(`${date}T00:00:00Z`);
      const day = d.getUTCDay();
      const monday = new Date(d.getTime() - ((day === 0 ? 6 : day - 1) * 86_400_000));
      const weekKey = monday.toISOString().slice(0, 10);
      weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + data.cost);
    }
    sections.push('### Weekly Trend');
    const weeklyCols: ColumnDef[] = [
      { header: 'Week' },
      { header: 'Cost', align: 'right' },
    ];
    const weeklyRows = [...weekMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, cost]) => [`w/${week}`, formatDollars(cost)]);
    sections.push(markdownTable(weeklyCols, weeklyRows));
  }

  return toolResult(sections.join('\n'));
}
