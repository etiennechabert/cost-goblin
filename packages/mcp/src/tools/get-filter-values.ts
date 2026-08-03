import {
  asDimensionId,
  buildSource,
  computePeriodsInRange,
  QueryBuilder,
  resolveField,
  logger,
} from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { truncateFooter, truncateRows } from '../formatters/cost.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
import {
  computeDataCoverage,
  defaultDateRange,
  emptyRangeResult,
  getQueryProviders,
  lookupDimension,
  resolveEntityName,
  resolveFormat,
  structuredToolResult,
  toDateRange,
  toNum,
  toStr,
  toolError,
} from './tool-helpers.js';
import type { DateRange } from '@costgoblin/core';

export async function getFilterValues(
  ctx: McpContext,
  params: {
    dimensionId: string;
    filters?: Record<string, readonly string[]> | undefined;
    dateRange?: { start: string; end: string } | undefined;
    limit?: number | undefined;
    format?: string | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
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

  // lookupDimension above already rejected unknown ids with a friendly error;
  // resolveField still throws SecurityError as defense in depth so the id can
  // never reach the SQL verbatim.
  const { fieldExpr } = resolveField(asDimensionId(dimensionId), dimensions);

  const qb = new QueryBuilder();
  const startParam = qb.addParam(dateRange.start);
  const endParam = qb.addParam(dateRange.end);

  const allProviders = await getQueryProviders(ctx, 'daily');
  const required = computePeriodsInRange(dateRange);
  // Per-provider month intersection; providers with nothing in range are
  // dropped (a zero-match glob fails the whole union).
  const branches = allProviders
    .map(pr => ({
      name: pr.name,
      periods: required.filter(m => pr.availablePeriods?.includes(m) ?? false),
      availableColumns: pr.availableColumns,
    }))
    .filter(b => b.periods.length > 0);
  if (branches.length === 0) {
    return emptyRangeResult(ctx, dateRange, format, `${dimLabel} Values (${dateRange.start} to ${dateRange.end})`);
  }
  const source = buildSource({
    dataDir: ctx.dataDir,
    tier: 'daily',
    dimensions,
    orgAccountsPath: orgPath,
    providers: branches,
    costMetric: 'unblended',
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

  const columns: Column[] = [
    { key: 'value', header: dimLabel },
    { key: 'cost', header: 'Cost', type: 'currency' },
    { key: 'pct', header: '% Total', type: 'percent' },
  ];

  const { visible, hiddenCount, hiddenCost } = truncateRows(items, limit, i => i.cost);
  const tableRows: Cell[][] = visible.map(i => [
    i.value,
    i.cost,
    totalCost > 0 ? (i.cost / totalCost) * 100 : 0,
  ]);

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `${dimLabel} Values (${dateRange.start} to ${dateRange.end})`,
    coverage,
    meta: [
      { label: 'Total', value: totalCost, type: 'currency' },
      { label: 'Distinct Values', value: items.length, type: 'number' },
    ],
    tables: [{ columns, rows: tableRows, footer: truncateFooter(hiddenCount, hiddenCost) }],
  };
  return structuredToolResult(result, format);
}
