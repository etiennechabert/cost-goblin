import {
  buildFilterClauses,
  buildSource,
  computePeriodsInRange,
  logger,
  QueryBuilder,
  tagDimColumn,
  tagSqlColumn,
} from '@costgoblin/core';
import type { DateRange, DimensionsConfig } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
import {
  computeDataCoverage,
  defaultDateRange,
  emptyRangeResult,
  getQueryProviders,
  resolveFormat,
  structuredToolResult,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
} from './tool-helpers.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const VALID_COLUMNS: ReadonlySet<string> = new Set([
  'usage_date', 'account_id', 'account_name', 'region', 'service',
  'service_code', 'service_category', 'charge_category', 'pricing_category',
  'commitment_status', 'operation', 'sku_meter',
  'description', 'resource_id', 'usage_amount', 'cost', 'list_cost',
]);

/** The SQL column behind a caller-supplied column: a VALID_COLUMNS name is its
 *  own column, a tag dimension id (`tag_team`, as list_dimensions shows it)
 *  maps to its tagSqlColumn. Null for anything else: these land in bare SQL
 *  positions (SELECT/GROUP BY/ORDER BY), so only allow-listed names get in. */
function sqlColumnFor(col: string, dimensions: DimensionsConfig): string | null {
  if (VALID_COLUMNS.has(col)) return col;
  const tag = dimensions.tags.find(t => tagDimColumn(t) === col);
  return tag === undefined ? null : tagSqlColumn(tag);
}

function sortDirectionSql(direction: 'asc' | 'desc'): string {
  return direction === 'asc' ? 'ASC' : 'DESC';
}

function groupedSortColumn(column: string): string {
  return column === 'cost' ? 'SUM(cost)' : column;
}

/** A group-by column: the caller's name (used for the output) and its SQL column. */
interface GroupByColumn {
  readonly key: string;
  readonly column: string;
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
    : defaultDateRange(ctx.now());
  // The schema already rejects non-integers and values < 1; this is the second
  // layer for direct callers.
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

  const dimensions = await ctx.getQueryDimensions();

  // Every value is bound: the dates, the filter values and the limit. Filter
  // dimension ids resolve through resolveField (unknown ids throw
  // SecurityError) up front, before any SQL runs or the empty-range early return.
  const qb = new QueryBuilder();
  const whereConditions = [
    `usage_date BETWEEN ${qb.addParam(dateRange.start)} AND ${qb.addParam(dateRange.end)}`,
    ...buildFilterClauses(toFilterMap(params.filters), dimensions, await ctx.getAccountReverseMap(), qb),
  ];
  const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
  const limitParam = qb.addParam(limit);
  const queryParams = qb.build().params;

  const orgPath = await ctx.getOrgAccountsPath();
  // Mirror the dashboards: the active Cost Scope's metric backs `cost`.
  const scopeMetric = await ctx.getCostScope().then(cs => cs.costMetric).catch(() => 'effective' as const);
  const allProviders = await getQueryProviders(ctx, 'daily');
  const required = computePeriodsInRange(dateRange);
  // Per-provider month intersection; providers with nothing in range are
  // dropped (a zero-match glob fails the whole union).
  const branches = allProviders
    .map(p => ({
      name: p.name,
      periods: required.filter(m => p.availablePeriods?.includes(m) ?? false),
    }))
    .filter(b => b.periods.length > 0);
  if (branches.length === 0) return emptyRangeResult(ctx, dateRange, format, `Explore Data (${dateRange.start} to ${dateRange.end})`);

  const matSource = ctx.materializedBase.getSource(dateRange, 'daily');
  const source = matSource ?? buildSource({
    dataDir: ctx.dataDir,
    tier: 'daily',
    dimensions,
    orgAccountsPath: orgPath,
    providers: branches,
    costMetric: scopeMetric,
  });

  const groupBy: GroupByColumn[] = (params.groupByColumns ?? []).flatMap(key => {
    const column = sqlColumnFor(key, dimensions);
    return column === null ? [] : [{ key, column }];
  });
  const sortColumn = params.sort === undefined ? null : sqlColumnFor(params.sort.column, dimensions);

  logger.info('explore-data', { dateRange, grouped: groupBy.length > 0 });

  const isSlim = matSource !== undefined;
  const hasListCost = !isSlim;

  if (groupBy.length > 0) {
    const selectCols = groupBy.map(({ column }) =>
      column === 'usage_date' ? `usage_date::VARCHAR AS usage_date` : column,
    );
    const groupByList = groupBy.map(g => g.column).join(', ');
    const sortExpr = params.sort !== undefined && sortColumn !== null
      ? `${groupedSortColumn(sortColumn)} ${sortDirectionSql(params.sort.direction)}`
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
      GROUP BY ${groupByList}
      ORDER BY ${sortExpr}
      LIMIT ${limitParam}
    `.trim();

    const rows = await ctx.runPreparedQuery(sql, queryParams);

    const columns: Column[] = [
      ...groupBy.map(({ key }): Column => ({ key, header: key })),
      { key: 'cost', header: 'Cost', type: 'currency' },
      { key: 'row_count', header: 'Rows', type: 'number' },
    ];

    const tableRows: Cell[][] = rows.map(r => [
      ...groupBy.map(({ column }): Cell => toStr(r[column])),
      toNum(r['cost']),
      toNum(r['row_count']),
    ]);

    const coverage = await computeDataCoverage(ctx, dateRange);
    const result: StructuredResult = {
      title: `Aggregated Data (${dateRange.start} to ${dateRange.end})`,
      coverage,
      meta: [{ label: 'Group By', value: groupBy.map(g => g.key).join(', ') }],
      tables: [{ columns, rows: tableRows }],
    };
    return structuredToolResult(result, format);
  }

  const sortExpr = params.sort !== undefined && sortColumn !== null
    ? `${sortColumn} ${sortDirectionSql(params.sort.direction)}`
    : 'ABS(cost) DESC';

  const rawCols = [
    'usage_date::VARCHAR AS usage_date',
    'account_id', 'account_name', 'region', 'service', 'service_category',
    'charge_category', 'resource_id',
    'CAST(cost AS DOUBLE) AS cost',
    ...(hasListCost ? ['CAST(list_cost AS DOUBLE) AS list_cost'] : []),
  ];

  const sql = `
    SELECT
      ${rawCols.join(', ')}
    FROM ${source}
    ${whereClause}
    ORDER BY ${sortExpr}
    LIMIT ${limitParam}
  `.trim();

  const rows = await ctx.runPreparedQuery(sql, queryParams);

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
