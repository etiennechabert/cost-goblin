import {
  buildFilterClauses,
  buildSource,
  computePeriodsInRange,
  logger,
  QueryBuilder,
  tagSqlColumn,
  tagSqlColumnsById,
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

/** Every name a caller may use for a column, mapped to the SQL column behind
 *  it: a VALID_COLUMNS name is its own column, and a tag is reachable by its
 *  dimension id (`tag_team`) or its SQL column (`tag_team_<hash>`), both of
 *  which list_dimensions shows. Anything else is refused: these land in bare
 *  SQL positions (SELECT/GROUP BY/ORDER BY), so only allow-listed names get in. */
function columnsByName(dimensions: DimensionsConfig): ReadonlyMap<string, string> {
  const columns = new Map<string, string>();
  for (const c of VALID_COLUMNS) columns.set(c, c);
  for (const t of dimensions.tags) {
    const column = tagSqlColumn(t);
    columns.set(column, column);
  }
  for (const [id, column] of tagSqlColumnsById(dimensions.tags)) {
    if (!columns.has(id)) columns.set(id, column);
  }
  return columns;
}

function sortDirectionSql(direction: 'asc' | 'desc'): string {
  return direction === 'asc' ? 'ASC' : 'DESC';
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
  const scopeMetric = (await ctx.getCostScope()).costMetric;
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

  const allowedColumns = columnsByName(dimensions);
  const groupBy: GroupByColumn[] = (params.groupByColumns ?? []).flatMap(key => {
    const column = allowedColumns.get(key);
    return column === undefined ? [] : [{ key, column }];
  });
  const sortColumn = params.sort === undefined ? undefined : allowedColumns.get(params.sort.column);

  logger.info('explore-data', { dateRange, grouped: groupBy.length > 0 });

  const isSlim = matSource !== undefined;
  const hasListCost = !isSlim;

  if (groupBy.length > 0) {
    const selectCols = groupBy.map(({ column }) =>
      column === 'usage_date' ? `usage_date::VARCHAR AS usage_date` : column,
    );
    const groupByList = groupBy.map(g => g.column).join(', ');
    // A grouped query can only order by cost or by a grouped column; anything
    // else is not in scope after GROUP BY, so it falls back to the cost sort.
    const groupedSortExpr = sortColumn === 'cost' ? 'SUM(cost)' : groupBy.find(g => g.column === sortColumn)?.column;
    const sortExpr = params.sort !== undefined && groupedSortExpr !== undefined
      ? `${groupedSortExpr} ${sortDirectionSql(params.sort.direction)}`
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

  const sortExpr = params.sort !== undefined && sortColumn !== undefined
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
