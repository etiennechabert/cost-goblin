import {
  buildSource,
  computePeriodsInRange,
  listLocalMonths,
  logger,
} from '@costgoblin/core';
import type { DateRange } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
import {
  computeDataCoverage,
  defaultDateRange,
  emptyRangeResult,
  getFirstProviderName,
  resolveFormat,
  structuredToolResult,
  toDateRange,
  toNum,
  toStr,
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
    format?: string | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const dateRange: DateRange = params.dateRange !== undefined
    ? toDateRange(params.dateRange)
    : defaultDateRange();
  const limit = Math.min(params.limit ?? 50, 200);

  const dimensions = await ctx.getQueryDimensions();
  const orgPath = await ctx.getOrgAccountsPath();
  const availableColumns = await ctx.getAvailableColumns('daily');
  const provider = await getFirstProviderName(ctx);
  const available = provider === null ? [] : await listLocalMonths(ctx.dataDir, provider, 'daily');
  const required = computePeriodsInRange(dateRange);
  const periods = required.filter(p => available.includes(p));
  if (provider === null || periods.length === 0) return emptyRangeResult(ctx, dateRange, format, `Explore Data (${dateRange.start} to ${dateRange.end})`);

  const matSource = ctx.materializedBase.getSource(dateRange, 'daily');
  const source = matSource ?? buildSource({
    dataDir: ctx.dataDir,
    tier: 'daily',
    dimensions,
    orgAccountsPath: orgPath,
    providers: [{ name: provider, periods, availableColumns }],
    costMetric: 'unblended',
  });

  const whereClause = `WHERE usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`;

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

    const columns: Column[] = [
      ...groupByColumns.map((c): Column => ({ key: c, header: c })),
      { key: 'cost', header: 'Cost', type: 'currency' },
      { key: 'row_count', header: 'Rows', type: 'number' },
    ];

    const tableRows: Cell[][] = rows.map(r => [
      ...groupByColumns.map((c): Cell => toStr(r[c])),
      toNum(r['cost']),
      toNum(r['row_count']),
    ]);

    const coverage = await computeDataCoverage(ctx, dateRange);
    const result: StructuredResult = {
      title: `Aggregated Data (${dateRange.start} to ${dateRange.end})`,
      coverage,
      meta: [{ label: 'Group By', value: groupByColumns.join(', ') }],
      tables: [{ columns, rows: tableRows }],
    };
    return structuredToolResult(result, format);
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

  const columns: Column[] = [
    { key: 'date', header: 'Date' },
    { key: 'account', header: 'Account' },
    { key: 'service', header: 'Service' },
    { key: 'resource', header: 'Resource' },
    { key: 'cost', header: 'Cost', type: 'currency' },
  ];

  const tableRows: Cell[][] = rows.map(r => {
    const resourceId = toStr(r['resource_id']);
    return [
      toStr(r['usage_date']),
      toStr(r['account_name']) || toStr(r['account_id']),
      toStr(r['service']),
      resourceId.length > 30 ? `${resourceId.slice(0, 27)}...` : resourceId,
      toNum(r['cost']),
    ];
  });

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `Raw Data (${dateRange.start} to ${dateRange.end})`,
    coverage,
    meta: [{ label: 'Showing', value: `${String(rows.length)} rows (sorted by |cost|)` }],
    tables: [{ columns, rows: tableRows }],
  };
  return structuredToolResult(result, format);
}
