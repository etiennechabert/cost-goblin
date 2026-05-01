import {
  buildCostQuery,
  logger,
} from '@costgoblin/core';
import type { DateRange, DimensionId } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars } from '../formatters/cost.js';
import { truncateRows, truncateFooter } from '../formatters/cost.js';
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

export async function queryCosts(
  ctx: McpContext,
  params: {
    groupBy: string;
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    limit?: number | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const groupBy: DimensionId = toDimensionId(params.groupBy);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const filters = toFilterMap(params.filters);
  const limit = params.limit ?? 15;

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) return toolError(`No data for ${dateRange.start} to ${dateRange.end}.`);

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

  const columns: ColumnDef[] = [
    { header: dimLabel },
    { header: 'Cost', align: 'right' },
    { header: '% Total', align: 'right' },
    ...topServices.map(s => ({ header: s, align: 'right' as const })),
  ];

  const { visible, hiddenCount, hiddenCost } = truncateRows(costRows, limit, r => r.totalCost);

  const tableRows = visible.map(r => [
    r.entity,
    formatDollars(r.totalCost),
    grandTotal > 0 ? `${((r.totalCost / grandTotal) * 100).toFixed(1)}%` : '0%',
    ...topServices.map(s => formatDollars(r.serviceCosts[s] ?? 0)),
  ]);

  const sections: string[] = [];
  sections.push(`## Costs by ${dimLabel} (${dateRange.start} to ${dateRange.end})`);
  sections.push('');
  sections.push(`**Total**: ${formatDollars(grandTotal)}`);
  sections.push('');
  sections.push(markdownTable(columns, tableRows));
  sections.push(truncateFooter(hiddenCount, hiddenCost));

  return toolResult(sections.join('\n'));
}
