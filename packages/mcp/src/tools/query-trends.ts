import {
  asEntityRef,
  asDollars,
  buildTrendQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId, TrendRow } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars, truncateRows, truncateFooter } from '../formatters/cost.js';
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
  toDollars,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
} from './tool-helpers.js';

export async function queryTrends(
  ctx: McpContext,
  params: {
    groupBy: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    deltaThreshold?: number | undefined;
    percentThreshold?: number | undefined;
    limit?: number | undefined;
    format?: string | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const groupBy: DimensionId = toDimensionId(params.groupBy);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const filters = toFilterMap(params.filters);
  const deltaThreshold = toDollars(params.deltaThreshold ?? 1);
  const percentThreshold = params.percentThreshold ?? 5;
  const limit = params.limit ?? 15;

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return emptyRangeResult(ctx, dateRange, format, `Cost Trends (${dateRange.start} to ${dateRange.end})`);

  const { sql, params: queryParams } = buildTrendQuery(
    { groupBy, dateRange, filters, deltaThreshold, percentThreshold },
    opts,
  );
  logger.info('query-trends', { groupBy, dateRange });
  const rows = await ctx.runPreparedQuery(sql, queryParams);

  const increases: TrendRow[] = [];
  const savings: TrendRow[] = [];
  let totalIncrease = 0;
  let totalSavings = 0;

  const accountMap = (groupBy === 'account' || groupBy === 'account_id')
    ? await ctx.getAccountMap()
    : new Map<string, string>();

  for (const row of rows) {
    const rawEntity = toStr(row['entity']);
    const entity = resolveEntityName(rawEntity, accountMap);
    const currentCost = toNum(row['current_cost']);
    const previousCost = toNum(row['previous_cost']);
    const delta = toNum(row['delta']);
    const percentChange = toNum(row['percent_change']);

    if (Math.abs(delta) < deltaThreshold) continue;
    if (Math.abs(percentChange) < percentThreshold) continue;

    const trendRow: TrendRow = {
      entity: asEntityRef(entity),
      currentCost: asDollars(currentCost),
      previousCost: asDollars(previousCost),
      delta: asDollars(delta),
      percentChange,
    };

    if (delta > 0) {
      increases.push(trendRow);
      totalIncrease += delta;
    } else {
      savings.push(trendRow);
      totalSavings += Math.abs(delta);
    }
  }

  increases.sort((a, b) => b.delta - a.delta);
  savings.sort((a, b) => a.delta - b.delta);

  const { label: dimLabel } = lookupDimension(groupBy, opts.dimensions);

  const trendColumns: Column[] = [
    { key: 'entity', header: dimLabel },
    { key: 'current', header: 'Current', type: 'currency' },
    { key: 'previous', header: 'Previous', type: 'currency' },
    { key: 'delta', header: 'Delta', type: 'delta' },
    { key: 'change', header: 'Change', type: 'change' },
  ];

  const tables: Table[] = [];
  const notes: string[] = [];

  if (increases.length > 0) {
    const { visible, hiddenCount, hiddenCost } = truncateRows(increases, limit, r => r.delta);
    const rows: Cell[][] = visible.map(r => [r.entity, r.currentCost, r.previousCost, r.delta, r.percentChange]);
    tables.push({
      title: `Top Increases (${formatDollars(totalIncrease)} total)`,
      columns: trendColumns,
      rows,
      footer: truncateFooter(hiddenCount, hiddenCost),
    });
  } else {
    notes.push('*No significant increases found.*');
  }

  if (savings.length > 0) {
    const { visible, hiddenCount, hiddenCost } = truncateRows(savings, limit, r => Math.abs(r.delta));
    const rows: Cell[][] = visible.map(r => [r.entity, r.currentCost, r.previousCost, r.delta, r.percentChange]);
    tables.push({
      title: `Top Savings (${formatDollars(totalSavings)} total)`,
      columns: trendColumns,
      rows,
      footer: truncateFooter(hiddenCount, hiddenCost),
    });
  } else {
    notes.push('*No significant savings found.*');
  }

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `Cost Trends by ${dimLabel} (${dateRange.start} to ${dateRange.end})`,
    coverage,
    notes,
    tables,
  };
  return structuredToolResult(result, format);
}
