import {
  asEntityRef,
  asDollars,
  buildTrendQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId, TrendRow } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars, formatPercent, formatDelta, truncateRows, truncateFooter } from '../formatters/cost.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import {
  buildQueryContextOpts,
  defaultDateRange,
  lookupDimension,
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

export async function queryTrends(
  ctx: McpContext,
  params: {
    groupBy: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    deltaThreshold?: number | undefined;
    percentThreshold?: number | undefined;
    limit?: number | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const groupBy: DimensionId = toDimensionId(params.groupBy);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const filters = toFilterMap(params.filters);
  const deltaThreshold = toDollars(params.deltaThreshold ?? 1);
  const percentThreshold = params.percentThreshold ?? 5;
  const limit = params.limit ?? 15;

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return toolError(`No data for ${dateRange.start} to ${dateRange.end}.`);

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

  const sections: string[] = [];
  sections.push(`## Cost Trends by ${dimLabel} (${dateRange.start} to ${dateRange.end})`);
  sections.push('');

  const trendColumns: ColumnDef[] = [
    { header: dimLabel },
    { header: 'Current', align: 'right' },
    { header: 'Previous', align: 'right' },
    { header: 'Delta', align: 'right' },
    { header: 'Change', align: 'right' },
  ];

  if (increases.length > 0) {
    sections.push(`### Top Increases (${formatDollars(totalIncrease)} total)`);
    sections.push('');
    const { visible, hiddenCount, hiddenCost } = truncateRows(increases, limit, r => r.delta);
    const tableRows = visible.map(r => [
      r.entity,
      formatDollars(r.currentCost),
      formatDollars(r.previousCost),
      formatDelta(r.delta),
      formatPercent(r.percentChange),
    ]);
    sections.push(markdownTable(trendColumns, tableRows));
    sections.push(truncateFooter(hiddenCount, hiddenCost));
  } else {
    sections.push('*No significant increases found.*');
  }

  sections.push('');

  if (savings.length > 0) {
    sections.push(`### Top Savings (${formatDollars(totalSavings)} total)`);
    sections.push('');
    const { visible, hiddenCount, hiddenCost } = truncateRows(savings, limit, r => Math.abs(r.delta));
    const tableRows = visible.map(r => [
      r.entity,
      formatDollars(r.currentCost),
      formatDollars(r.previousCost),
      formatDelta(r.delta),
      formatPercent(r.percentChange),
    ]);
    sections.push(markdownTable(trendColumns, tableRows));
    sections.push(truncateFooter(hiddenCount, hiddenCost));
  } else {
    sections.push('*No significant savings found.*');
  }

  return toolResult(sections.join('\n'));
}
