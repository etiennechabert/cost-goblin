import {
  buildAliasSqlCase,
  buildSource,
  computePeriodsInRange,
  QueryBuilder,
  tagDimColumn,
  logger,
} from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars } from '../formatters/cost.js';
import { truncateFooter, truncateRows } from '../formatters/cost.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import {
  defaultDateRange,
  lookupDimension,
  resolveEntityName,
  toDateRange,
  toNum,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';
import type { DateRange } from '@costgoblin/core';

export async function getFilterValues(
  ctx: McpContext,
  params: {
    dimensionId: string;
    filters?: Record<string, readonly string[]> | undefined;
    dateRange?: { start: string; end: string } | undefined;
    limit?: number | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const dimensionId = params.dimensionId;
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const limit = params.limit ?? 50;

  const dimensions = await ctx.getQueryDimensions();
  const { label: dimLabel, found } = lookupDimension(dimensionId, dimensions);
  if (!found) return toolError(`Unknown dimension "${dimensionId}". Use list_dimensions to see available dimensions.`);

  const accountMap = await ctx.getAccountMap();
  const orgPath = await ctx.getOrgAccountsPath();
  const availableColumns = await ctx.getAvailableColumns('daily');

  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  const tag = dimensions.tags.find(d => tagDimColumn(d) === dimensionId);
  const field = builtIn !== undefined ? builtIn.field : dimensionId;
  let fieldExpr = field;
  if (builtIn !== undefined) fieldExpr = buildAliasSqlCase(field, builtIn);
  else if (tag !== undefined) fieldExpr = buildAliasSqlCase(field, tag);

  const qb = new QueryBuilder();
  const startParam = qb.addParam(dateRange.start);
  const endParam = qb.addParam(dateRange.end);

  const periods = computePeriodsInRange(dateRange);
  const source = buildSource({
    dataDir: ctx.dataDir,
    tier: 'daily',
    dimensions,
    orgAccountsPath: orgPath,
    periods,
    costMetric: 'unblended',
    availableColumns,
  });

  const sql = `
    SELECT ${fieldExpr} AS val, SUM(cost) AS total_cost
    FROM ${source}
    WHERE usage_date BETWEEN ${startParam} AND ${endParam}
    GROUP BY val
    HAVING val IS NOT NULL AND val != ''
    ORDER BY total_cost DESC
    LIMIT 200
  `.trim();

  logger.info('get-filter-values', { dimensionId, dateRange });
  const queryParams = qb.build().params;
  const rows = await ctx.runPreparedQuery(sql, queryParams);

  const isAccountDim = dimensionId === 'account' || dimensionId === 'account_id';
  let items: { value: string; cost: number }[];

  if (isAccountDim) {
    const merged = new Map<string, number>();
    for (const r of rows) {
      const rawVal = toStr(r['val']);
      const name = resolveEntityName(rawVal, accountMap);
      merged.set(name, (merged.get(name) ?? 0) + toNum(r['total_cost']));
    }
    items = [...merged.entries()]
      .map(([value, cost]) => ({ value, cost }))
      .sort((a, b) => b.cost - a.cost);
  } else {
    items = rows.map(r => ({
      value: toStr(r['val']),
      cost: toNum(r['total_cost']),
    }));
  }

  const totalCost = items.reduce((sum, i) => sum + i.cost, 0);

  const columns: ColumnDef[] = [
    { header: dimLabel },
    { header: 'Cost', align: 'right' },
    { header: '% Total', align: 'right' },
  ];

  const { visible, hiddenCount, hiddenCost } = truncateRows(items, limit, i => i.cost);
  const tableRows = visible.map(i => [
    i.value,
    formatDollars(i.cost),
    totalCost > 0 ? `${((i.cost / totalCost) * 100).toFixed(1)}%` : '0%',
  ]);

  const sections: string[] = [];
  sections.push(`## ${dimLabel} Values (${dateRange.start} to ${dateRange.end})`);
  sections.push('');
  sections.push(`**Total**: ${formatDollars(totalCost)} across ${String(items.length)} values`);
  sections.push('');
  sections.push(markdownTable(columns, tableRows));
  sections.push(truncateFooter(hiddenCount, hiddenCost));

  return toolResult(sections.join('\n'));
}
