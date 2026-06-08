import {
  buildCostQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { truncateRows, truncateFooter } from '../formatters/cost.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
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

export async function queryCosts(
  ctx: McpContext,
  params: {
    groupBy: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
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
  const limit = params.limit ?? 15;

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return emptyRangeResult(ctx, dateRange, format, `Costs by ${params.groupBy} (${dateRange.start} to ${dateRange.end})`);

  const { sql, params: queryParams } = buildCostQuery(
    { groupBy, dateRange, filters },
    opts,
  );
  logger.info('query-costs', { groupBy, dateRange });
  const rows = await ctx.runPreparedQuery(sql, queryParams);

  const entityMap = new Map<string, { totalCost: number; serviceCosts: Record<string, number> }>();
  const serviceTotals = new Map<string, number>();

  for (const row of rows) {
    const entity = toStr(row['entity']);
    const totalCost = toNum(row['total_cost']);
    const service = typeof row['service'] === 'string' ? row['service'] : null;
    const serviceCost = toNum(row['service_cost']);

    if (!entityMap.has(entity)) {
      entityMap.set(entity, { totalCost, serviceCosts: {} });
    }
    if (service !== null && service.length > 0) {
      const entry = entityMap.get(entity);
      if (entry !== undefined) entry.serviceCosts[service] = serviceCost;
      serviceTotals.set(service, (serviceTotals.get(service) ?? 0) + serviceCost);
    }
  }

  const accountMap = (groupBy === 'account' || groupBy === 'account_id')
    ? await ctx.getAccountMap()
    : new Map<string, string>();

  const costRows: { entity: string; totalCost: number; serviceCosts: Record<string, number> }[] = [];
  let grandTotal = 0;
  for (const [entity, data] of entityMap) {
    const name = resolveEntityName(entity, accountMap);
    costRows.push({ entity: name, totalCost: data.totalCost, serviceCosts: data.serviceCosts });
    grandTotal += data.totalCost;
  }
  costRows.sort((a, b) => b.totalCost - a.totalCost);

  const topServices = [...serviceTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  const { label: dimLabel } = lookupDimension(groupBy, opts.dimensions);

  const columns: Column[] = [
    { key: 'entity', header: dimLabel },
    { key: 'cost', header: 'Cost', type: 'currency' },
    { key: 'pct', header: '% Total', type: 'percent' },
    ...topServices.map((s): Column => ({ key: `svc_${s}`, header: s, type: 'currency' })),
  ];

  const { visible, hiddenCount, hiddenCost } = truncateRows(costRows, limit, r => r.totalCost);

  const tableRows: Cell[][] = visible.map(r => [
    r.entity,
    r.totalCost,
    grandTotal > 0 ? (r.totalCost / grandTotal) * 100 : 0,
    ...topServices.map((s): Cell => r.serviceCosts[s] ?? 0),
  ]);

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `Costs by ${dimLabel} (${dateRange.start} to ${dateRange.end})`,
    coverage,
    meta: [{ label: 'Total', value: grandTotal, type: 'currency' }],
    tables: [{ columns, rows: tableRows, footer: truncateFooter(hiddenCount, hiddenCost) }],
  };
  return structuredToolResult(result, format);
}
