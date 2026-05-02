import {
  buildSource,
  computePeriodsInRange,
  listLocalMonths,
  logger,
} from '@costgoblin/core';
import type { DateRange } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars, formatNumber } from '../formatters/cost.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import {
  defaultDateRange,
  toDateRange,
  toNum,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';

const VALID_COLUMNS: ReadonlySet<string> = new Set([
  'usage_date', 'account_id', 'account_name', 'region', 'service',
  'service_family', 'line_item_type', 'operation', 'usage_type',
  'description', 'resource_id', 'usage_amount', 'cost', 'list_cost',
]);

function isValidColumn(col: string): boolean {
  return VALID_COLUMNS.has(col) || col.startsWith('tag_');
}

export async function exploreData(
  ctx: McpContext,
  params: {
    dateRange?: { start: string; end: string } | undefined;
    filters?: Record<string, readonly string[]> | undefined;
    groupByColumns?: readonly string[] | undefined;
    sort?: { column: string; direction: 'asc' | 'desc' } | undefined;
    limit?: number | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const limit = Math.min(params.limit ?? 50, 200);

  const dimensions = await ctx.getQueryDimensions();
  const orgPath = await ctx.getOrgAccountsPath();
  const availableColumns = await ctx.getAvailableColumns('daily');
  const available = await listLocalMonths(ctx.dataDir, 'daily');
  const required = computePeriodsInRange(dateRange);
  const periods = required.filter(p => available.includes(p));
  if (periods.length === 0) return toolError(`No data for ${dateRange.start} to ${dateRange.end}.`);

  const matSource = ctx.materializedBase.getSource(dateRange, 'daily');
  const source = matSource ?? buildSource({
    dataDir: ctx.dataDir,
    tier: 'daily',
    dimensions,
    orgAccountsPath: orgPath,
    periods,
    costMetric: 'unblended',
    availableColumns,
  });

  const whereClause = matSource !== undefined
    ? ''
    : `WHERE usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`;

  const groupByColumns = params.groupByColumns?.filter(c => isValidColumn(c));

  logger.info('explore-data', { dateRange, grouped: groupByColumns !== undefined && groupByColumns.length > 0 });

  const isSlim = matSource !== undefined;
  const hasListCost = !isSlim && availableColumns.has('pricing_public_on_demand_cost');

  if (groupByColumns !== undefined && groupByColumns.length > 0) {
    const selectCols = groupByColumns.map(col =>
      col === 'usage_date' ? `usage_date::VARCHAR AS usage_date` : col,
    );
    const sortExpr = params.sort !== undefined && isValidColumn(params.sort.column)
      ? `${params.sort.column === 'cost' ? 'SUM(cost)' : params.sort.column} ${params.sort.direction === 'asc' ? 'ASC' : 'DESC'}`
      : 'SUM(cost) DESC';

    const aggCols = [
      'CAST(SUM(cost) AS DOUBLE) AS cost',
      ...(hasListCost ? ['CAST(SUM(list_cost) AS DOUBLE) AS list_cost'] : []),
      ...(!isSlim ? ['CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount'] : []),
      'CAST(COUNT(*) AS DOUBLE) AS row_count',
    ];

    const sql = `
      SELECT
        ${selectCols.join(', ')},
        ${aggCols.join(',\n        ')}
      FROM ${source}
      ${whereClause}
      GROUP BY ${groupByColumns.join(', ')}
      ORDER BY ${sortExpr}
      LIMIT ${String(limit)}
    `.trim();

    const rows = await ctx.runQuery(sql);

    const columns: ColumnDef[] = [
      ...groupByColumns.map(c => ({ header: c })),
      { header: 'Cost', align: 'right' as const },
      { header: 'Rows', align: 'right' as const },
    ];

    const tableRows = rows.map(r => [
      ...groupByColumns.map(c => toStr(r[c])),
      formatDollars(toNum(r['cost'])),
      formatNumber(toNum(r['row_count'])),
    ]);

    const sections: string[] = [];
    sections.push(`## Aggregated Data (${dateRange.start} to ${dateRange.end})`);
    sections.push(`**Group By**: ${groupByColumns.join(', ')}`);
    sections.push('');
    sections.push(markdownTable(columns, tableRows));
    return toolResult(sections.join('\n'));
  }

  const sortExpr = params.sort !== undefined && isValidColumn(params.sort.column)
    ? `${params.sort.column} ${params.sort.direction === 'asc' ? 'ASC' : 'DESC'}`
    : 'ABS(cost) DESC';

  const rawCols = [
    'usage_date::VARCHAR AS usage_date',
    'account_id', 'account_name', 'region', 'service', 'service_family',
    'line_item_type', 'resource_id',
    'CAST(cost AS DOUBLE) AS cost',
    ...(hasListCost ? ['CAST(list_cost AS DOUBLE) AS list_cost'] : []),
  ];

  const sql = `
    SELECT
      ${rawCols.join(', ')}
    FROM ${source}
    ${whereClause}
    ORDER BY ${sortExpr}
    LIMIT ${String(limit)}
  `.trim();

  const rows = await ctx.runQuery(sql);

  const columns: ColumnDef[] = [
    { header: 'Date' },
    { header: 'Account' },
    { header: 'Service' },
    { header: 'Resource' },
    { header: 'Cost', align: 'right' },
  ];

  const tableRows = rows.map(r => {
    const resourceId = toStr(r['resource_id']);
    return [
      toStr(r['usage_date']),
      toStr(r['account_name']) || toStr(r['account_id']),
      toStr(r['service']),
      resourceId.length > 30 ? `${resourceId.slice(0, 27)}...` : resourceId,
      formatDollars(toNum(r['cost'])),
    ];
  });

  const sections: string[] = [];
  sections.push(`## Raw Data (${dateRange.start} to ${dateRange.end})`);
  sections.push(`**Showing**: ${String(rows.length)} rows (sorted by |cost|)`);
  sections.push('');
  sections.push(markdownTable(columns, tableRows));

  return toolResult(sections.join('\n'));
}
