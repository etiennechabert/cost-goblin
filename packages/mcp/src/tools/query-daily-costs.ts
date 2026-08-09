import {
  asDimensionId,
  buildDailyCostsQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
import {
  buildQueryContextOpts,
  computeDataCoverage,
  defaultDateRange,
  emptyRangeResult,
  lookupDimension,
  resolveFormat,
  structuredToolResult,
  toDimensionId,
  toDateRange,
  toFilterMap,
  toNum,
} from './tool-helpers.js';

export async function queryDailyCosts(
  ctx: McpContext,
  params: {
    groupBy?: string | undefined;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    format?: string | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const groupBy: DimensionId = params.groupBy !== undefined
    ? toDimensionId(params.groupBy)
    : asDimensionId('service');
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const filters = toFilterMap(params.filters);

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return emptyRangeResult(ctx, dateRange, format, `Daily Costs (${dateRange.start} to ${dateRange.end})`);

  const { sql, params: queryParams } = buildDailyCostsQuery(
    { groupBy, dateRange, filters },
    opts,
  );
  logger.info('query-daily-costs', { groupBy, dateRange });
  const rows = await ctx.runPreparedQuery(sql, queryParams);

  const dayMap = new Map<string, Record<string, number>>();
  let totalCost = 0;

  for (const row of rows) {
    const rawDate = row['date'];
    let date: string;
    if (rawDate instanceof Date) {
      date = rawDate.toISOString().slice(0, 10);
    } else if (typeof rawDate === 'string') {
      date = rawDate;
    } else {
      date = '';
    }
    const group = typeof row['group_name'] === 'string' ? row['group_name'] : '';
    const cost = toNum(row['cost']);

    totalCost += cost;

    const existing = dayMap.get(date);
    if (existing === undefined) {
      dayMap.set(date, { [group]: cost });
    } else {
      existing[group] = (existing[group] ?? 0) + cost;
    }
  }

  const sortedDays = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const groupTotals = new Map<string, number>();
  for (const [, breakdown] of sortedDays) {
    for (const [group, cost] of Object.entries(breakdown)) {
      groupTotals.set(group, (groupTotals.get(group) ?? 0) + cost);
    }
  }
  const topGroups = [...groupTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  const { label: dimLabel } = lookupDimension(groupBy, opts.dimensions);

  const startMs = new Date(`${dateRange.start}T00:00:00Z`).getTime();
  const endMs = new Date(`${dateRange.end}T00:00:00Z`).getTime();
  const windowDays = Math.round((endMs - startMs) / 86_400_000) + 1;
  const useWeekly = windowDays > 14;

  const columns: Column[] = [
    { key: 'date', header: useWeekly ? 'Week' : 'Date' },
    { key: 'total', header: 'Total', type: 'currency' },
    ...topGroups.map((g): Column => ({ key: `grp_${g}`, header: g, type: 'currency' })),
  ];

  let tableRows: Cell[][];
  if (useWeekly) {
    const weekMap = new Map<string, Record<string, number>>();
    for (const [date, breakdown] of sortedDays) {
      const d = new Date(`${date}T00:00:00Z`);
      const day = d.getUTCDay();
      const monday = new Date(d.getTime() - ((day === 0 ? 6 : day - 1) * 86_400_000));
      const weekKey = monday.toISOString().slice(0, 10);
      const existing = weekMap.get(weekKey);
      if (existing === undefined) {
        weekMap.set(weekKey, { ...breakdown });
      } else {
        for (const [group, cost] of Object.entries(breakdown)) {
          existing[group] = (existing[group] ?? 0) + cost;
        }
      }
    }
    const sortedWeeks = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    tableRows = sortedWeeks.map(([week, breakdown]): Cell[] => {
      const dayTotal = Object.values(breakdown).reduce((s, v) => s + v, 0);
      return [
        `w/${week}`,
        dayTotal,
        ...topGroups.map((g): Cell => breakdown[g] ?? 0),
      ];
    });
  } else {
    tableRows = sortedDays.map(([date, breakdown]): Cell[] => {
      const dayTotal = Object.values(breakdown).reduce((s, v) => s + v, 0);
      return [
        date,
        dayTotal,
        ...topGroups.map((g): Cell => breakdown[g] ?? 0),
      ];
    });
  }

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `${useWeekly ? 'Weekly' : 'Daily'} Costs by ${dimLabel} (${dateRange.start} to ${dateRange.end})`,
    coverage,
    meta: [{ label: 'Total', value: totalCost, type: 'currency' }],
    tables: [{ columns, rows: tableRows }],
  };
  return structuredToolResult(result, format);
}
