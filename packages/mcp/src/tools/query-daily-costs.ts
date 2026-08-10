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
  mondayOf,
  resolveFormat,
  structuredToolResult,
  toDimensionId,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
} from './tool-helpers.js';

/** One bucket's per-group costs; the key is a day, or a week's Monday after
 *  bucketByWeek. */
type BucketBreakdown = readonly [string, Record<string, number>];

function aggregateByDay(rows: readonly Readonly<Record<string, unknown>>[]): { dayMap: Map<string, Record<string, number>>; totalCost: number } {
  const dayMap = new Map<string, Record<string, number>>();
  let totalCost = 0;
  for (const row of rows) {
    const date = toStr(row['date']);
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
  return { dayMap, totalCost };
}

/** The 5 costliest groups over the window — the only ones broken out as columns. */
function topGroupsOf(sortedDays: readonly BucketBreakdown[]): string[] {
  const groupTotals = new Map<string, number>();
  for (const [, breakdown] of sortedDays) {
    for (const [group, cost] of Object.entries(breakdown)) {
      groupTotals.set(group, (groupTotals.get(group) ?? 0) + cost);
    }
  }
  return [...groupTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
}

/** Re-buckets daily breakdowns into weeks keyed by their Monday. */
function bucketByWeek(sortedDays: readonly BucketBreakdown[]): BucketBreakdown[] {
  const weekMap = new Map<string, Record<string, number>>();
  for (const [date, breakdown] of sortedDays) {
    const weekKey = mondayOf(date);
    const existing = weekMap.get(weekKey);
    if (existing === undefined) {
      weekMap.set(weekKey, { ...breakdown });
    } else {
      for (const [group, cost] of Object.entries(breakdown)) {
        existing[group] = (existing[group] ?? 0) + cost;
      }
    }
  }
  return [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Column list and row shape are one positional contract: [label, total,
 *  ...topGroups]. These two builders sit together so an edit to either has the
 *  counterpart in view. */
function breakdownColumns(dateHeader: string, topGroups: readonly string[]): Column[] {
  return [
    { key: 'date', header: dateHeader },
    { key: 'total', header: 'Total', type: 'currency' },
    ...topGroups.map((g): Column => ({ key: `grp_${g}`, header: g, type: 'currency' })),
  ];
}

function breakdownRows(entries: readonly BucketBreakdown[], topGroups: readonly string[], labelOf: (key: string) => string): Cell[][] {
  return entries.map(([key, breakdown]): Cell[] => {
    const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
    return [labelOf(key), total, ...topGroups.map((g): Cell => breakdown[g] ?? 0)];
  });
}

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

  const { dayMap, totalCost } = aggregateByDay(rows);
  const sortedDays: BucketBreakdown[] = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const topGroups = topGroupsOf(sortedDays);

  const { label: dimLabel } = lookupDimension(groupBy, opts.dimensions);

  const startMs = new Date(`${dateRange.start}T00:00:00Z`).getTime();
  const endMs = new Date(`${dateRange.end}T00:00:00Z`).getTime();
  const windowDays = Math.round((endMs - startMs) / 86_400_000) + 1;
  const useWeekly = windowDays > 14;

  const columns = breakdownColumns(useWeekly ? 'Week' : 'Date', topGroups);
  const tableRows: Cell[][] = useWeekly
    ? breakdownRows(bucketByWeek(sortedDays), topGroups, (week) => `w/${week}`)
    : breakdownRows(sortedDays, topGroups, (date) => date);

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `${useWeekly ? 'Weekly' : 'Daily'} Costs by ${dimLabel} (${dateRange.start} to ${dateRange.end})`,
    coverage,
    meta: [{ label: 'Total', value: totalCost, type: 'currency' }],
    tables: [{ columns, rows: tableRows }],
  };
  return structuredToolResult(result, format);
}
