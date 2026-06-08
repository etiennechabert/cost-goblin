import {
  asEntityRef,
  buildEntityDetailQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId, EntityRef } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult, Table } from '../formatters/result.js';
import {
  buildQueryContextOpts,
  computeDataCoverage,
  defaultDateRange,
  emptyRangeResult,
  lookupDimension,
  resolveEntityName,
  resolveFormat,
  structuredToolResult,
  toDimensionId,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
} from './tool-helpers.js';

export async function queryEntityDetail(
  ctx: McpContext,
  params: {
    entity: string;
    dimension: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    format?: string | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const entity: EntityRef = asEntityRef(params.entity);
  const dimension: DimensionId = toDimensionId(params.dimension);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const filters = toFilterMap(params.filters);

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return emptyRangeResult(ctx, dateRange, format, `${params.entity} (${dateRange.start} to ${dateRange.end})`);

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

  const tables: Table[] = [];

  const svcSlices = [...serviceMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (svcSlices.length > 0) {
    const svcCols: Column[] = [
      { key: 'service', header: 'Service' },
      { key: 'cost', header: 'Cost', type: 'currency' },
      { key: 'pct', header: '% Total', type: 'percent' },
    ];
    const svcRows: Cell[][] = svcSlices.map(([name, cost]) => [
      name,
      cost,
      totalCost > 0 ? (cost / totalCost) * 100 : 0,
    ]);
    tables.push({ title: 'Service Breakdown', columns: svcCols, rows: svcRows });
  }

  const acctSlices = [...accountCostMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (acctSlices.length > 1) {
    const acctCols: Column[] = [
      { key: 'account', header: 'Account' },
      { key: 'cost', header: 'Cost', type: 'currency' },
      { key: 'pct', header: '% Total', type: 'percent' },
    ];
    const acctRows: Cell[][] = acctSlices.map(([id, cost]) => [
      resolveEntityName(id, accountMap),
      cost,
      totalCost > 0 ? (cost / totalCost) * 100 : 0,
    ]);
    tables.push({ title: 'Account Breakdown', columns: acctCols, rows: acctRows });
  }

  const sortedDays = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sortedDays.length > 0 && sortedDays.length <= 31) {
    const dailyCols: Column[] = [
      { key: 'date', header: 'Date' },
      { key: 'cost', header: 'Cost', type: 'currency' },
    ];
    const dailyRows: Cell[][] = sortedDays.map(([date, data]) => [date, data.cost]);
    tables.push({ title: 'Daily Trend', columns: dailyCols, rows: dailyRows });
  } else if (sortedDays.length > 31) {
    const weekMap = new Map<string, number>();
    for (const [date, data] of sortedDays) {
      const d = new Date(`${date}T00:00:00Z`);
      const day = d.getUTCDay();
      const monday = new Date(d.getTime() - ((day === 0 ? 6 : day - 1) * 86_400_000));
      const weekKey = monday.toISOString().slice(0, 10);
      weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + data.cost);
    }
    const weeklyCols: Column[] = [
      { key: 'week', header: 'Week' },
      { key: 'cost', header: 'Cost', type: 'currency' },
    ];
    const weeklyRows: Cell[][] = [...weekMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, cost]) => [`w/${week}`, cost]);
    tables.push({ title: 'Weekly Trend', columns: weeklyCols, rows: weeklyRows });
  }

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `${params.entity} (${dimLabel})`,
    coverage,
    meta: [
      { label: 'Period', value: `${dateRange.start} to ${dateRange.end}` },
      { label: 'Total Cost', value: totalCost, type: 'currency' },
    ],
    tables,
  };
  return structuredToolResult(result, format);
}
