import {
  asEntityRef,
  asDollars,
  buildTrendQuery,
  computePeriodsInRange,
  isNewTrend,
  logger,
  meetsTrendThresholds,
  previousTrendPeriod,
} from '@costgoblin/core';
import type { DimensionId, TrendRow } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars, truncateRows, truncateFooter } from '../formatters/cost.js';
import type { Cell, Column, StructuredResult, Table } from '../formatters/result.js';
import {
  buildQueryContextOpts,
  computeDataCoverage,
  emptyRangeResult,
  lookupDimension,
  resolveEntityName,
  resolveFormat,
  resolveToolDateRange,
  structuredToolResult,
  toDimensionId,
  toDollars,
  toFilterMap,
  toNum,
  toStr,
  withinLagResult,
} from './tool-helpers.js';

/** Legend for the ±100% of an entity with no previous-period cost, which an
 *  MCP client would otherwise read as a doubling or a drop to zero. Anchored
 *  on the $0 previous cost: -100% alone is also a real drop to $0. */
const NEW_TREND_NOTE = '*+100% / -100% with a previous cost of $0 is new spend / a new credit: there is nothing to compare against.*';

function showsNewTrend(rows: readonly TrendRow[]): boolean {
  return rows.some(r => isNewTrend(r.currentCost, r.previousCost));
}

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
  const range = await resolveToolDateRange(ctx, params.dateRange);
  if (range.kind === 'within-lag') return withinLagResult(ctx, range, format, 'Cost Trends');
  const { dateRange, cappedAt } = range;
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

    if (!meetsTrendThresholds({ currentCost, previousCost, delta, percentChange }, deltaThreshold, percentThreshold)) continue;

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
  const shown: (readonly TrendRow[])[] = [];

  if (increases.length > 0) {
    const { visible, hiddenCount, hiddenCost } = truncateRows(increases, limit, r => r.delta);
    shown.push(visible);
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
    shown.push(visible);
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
  if (shown.some(showsNewTrend)) {
    notes.push(NEW_TREND_NOTE);
    // A previous-period month with no synced data reads as $0, so every
    // entity looks new: say so, or a data gap is reported as new spend.
    const previous = previousTrendPeriod(dateRange);
    const unsynced = computePeriodsInRange(previous)
      .filter(m => !opts.providers.some(p => p.availablePeriods?.includes(m) ?? false));
    if (unsynced.length > 0) {
      notes.push(`*The previous period (${previous.start} to ${previous.end}) has no synced data for ${unsynced.join(', ')}: an entity shown as new may only be missing that history.*`);
    }
  }

  const coverage = await computeDataCoverage(ctx, dateRange, cappedAt);
  const result: StructuredResult = {
    title: `Cost Trends by ${dimLabel} (${dateRange.start} to ${dateRange.end})`,
    coverage,
    notes,
    tables,
  };
  return structuredToolResult(result, format);
}
