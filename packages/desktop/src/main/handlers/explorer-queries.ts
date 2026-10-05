/** The Explorer's queries: the histogram and totals, sample rows, the
 *  aggregated table and its filter values. Kept apart from the IPC handlers
 *  (no electron import) so they run in unit tests against real DuckDB. */

import {
  QueryBuilder,
  asDimensionId,
  buildSource,
  computePeriodsInRange,
  logger,
  resolveField,
  tagDimColumn,
} from '@costgoblin/core';
import type {
  AggregatedTableParams,
  AggregatedTableResult,
  AggregatedTableRow,
  DimensionsConfig,
  ExplorerBaseParams,
  ExplorerDailyRow,
  ExplorerFilterMap,
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerRowsParams,
  ExplorerRowsResult,
  ExplorerSampleRow,
  ExplorerSort,
  ExplorerTagColumn,
  ProviderSourceSpec,
} from '@costgoblin/core';
import type { RawRow } from '../duckdb-client.js';
import type { AppContext } from './context.js';
import { buildAccountReverseMap, columnForDimension, resolveRollupSource, toNum, toStr } from './query-utils.js';
import { resolveScopeMetric } from './explorer-scope.js';
import { resolveExplorerDateRange } from './query-windows.js';
import {
  EXPLORER_SCALAR_COLUMNS,
  appendRowFilters,
  buildExplorerWhere,
  resolveAggregatedSort,
  type ParameterizedWhere,
} from './explorer-sql.js';

/** What the Explorer queries read from the app context. */
export type ExplorerDeps = Pick<
  AppContext,
  'getCostScope' | 'getOrgAccountsPath' | 'getQueryDimensions' | 'getAccountMap' | 'getQueryProviders' | 'getAccountReverseMap' | 'runPreparedQuery' | 'rollupStore'
> & {
  readonly dataDir: string;
  /** The app clock (pinned by COSTGOBLIN_NOW in e2e). */
  readonly now: () => number;
};

const MAX_ROW_LIMIT = 1000;

function clampRowLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(Math.floor(n), MAX_ROW_LIMIT);
}

function buildOrderBy(
  sort: ExplorerSort | undefined,
  tagColumnIds: ReadonlySet<string>,
): string {
  if (sort === undefined) return 'ABS(cost) DESC';
  const dir = sort.direction === 'asc' ? 'ASC' : 'DESC';
  if (EXPLORER_SCALAR_COLUMNS.has(sort.column) || tagColumnIds.has(sort.column)) {
    return `${sort.column} ${dir}`;
  }
  return 'ABS(cost) DESC';
}

/** Everything the overview / rows / filter-values handlers compute up front.
 *  `empty === true` when no matching months are on disk — caller returns a
 *  zero-filled result without bothering DuckDB. */
interface QueryContext {
  readonly empty: boolean;
  readonly providers: readonly ProviderSourceSpec[];
  readonly source: string;
  /** Shared by every query over `source`; extend it through appendRowFilters
   *  or a QueryBuilder seeded with its params. */
  readonly where: ParameterizedWhere;
  readonly startStr: string;
  readonly endStr: string;
  readonly windowDays: number;
  readonly tier: 'daily' | 'hourly';
  readonly tagColumns: readonly ExplorerTagColumn[];
  readonly tagIdSet: ReadonlySet<string>;
  readonly dimensions: DimensionsConfig;
  readonly accountMap: ReadonlyMap<string, string>;
}

interface BuildFreshSourceOptions {
  readonly deps: ExplorerDeps;
  readonly params: ExplorerBaseParams;
  readonly startStr: string;
  readonly endStr: string;
  readonly startHour?: string;
  readonly endHour?: string;
  readonly tier: 'daily' | 'hourly';
  readonly periods: readonly string[];
  readonly providers: readonly ProviderSourceSpec[];
  readonly dimensions: DimensionsConfig;
  readonly accountReverseMap: ReadonlyMap<string, readonly string[]>;
}

async function buildFreshSource(opts: BuildFreshSourceOptions): Promise<{ source: string; where: ParameterizedWhere }> {
  const { deps, params, startStr, endStr, startHour, endHour, tier, periods, providers, dimensions, accountReverseMap } = opts;
  const { dataDir, getCostScope, getOrgAccountsPath } = deps;
  const orgPath = await getOrgAccountsPath();
  const applyCostScope = params.applyCostScope === true;
  // Marketplace re-attribution fixes which service a cost belongs to (a data
  // quality fix, not an exclusion), so it follows its own toggle and applies
  // regardless of the "Apply Cost Scope" checkbox — otherwise the Explorer and
  // its filter dropdowns would disagree with the dashboard on Bedrock spend.
  const fullScope = await getCostScope().catch(() => undefined);
  const scopeForExclusions = applyCostScope ? fullScope : undefined;
  // When the caller applies the cost scope but doesn't override the metric
  // (every dashboard widget — only the Explorer view sets it explicitly),
  // inherit it from the global scope instead of silently defaulting.
  const metric = resolveScopeMetric(params.costMetric, applyCostScope, scopeForExclusions);

  // Per-provider month intersection: a shared list would hand providers
  // globs for months they don't have on disk, and one zero-match glob fails
  // the whole union (DuckDB IO error). Providers with nothing in range are
  // dropped; the caller already early-returned when NO provider has months.
  const branches = providers
    .map(p => ({
      name: p.name,
      periods: periods.filter(m => p.availablePeriods?.includes(m) ?? false),
    }))
    .filter(b => b.periods.length > 0);
  const source = buildSource({
    dataDir, tier, dimensions, orgAccountsPath: orgPath,
    providers: branches,
    costMetric: metric, marketplaceAttribution: fullScope?.marketplaceAttribution,
  });
  // When the histogram drag-zoom emits hour bounds, the WHERE swaps the
  // day-level window for an hour-level one so the rest of the Explorer
  // (overview, table, sample rows) matches what the user dragged. usage_hour
  // only exists on the hourly tier — caller forces tier='hourly' in that case.
  const where = buildExplorerWhere({
    startStr, endStr, startHour, endHour, tier,
    filters: params.filters, dimensions, accountReverseMap,
    exclusionRules: scopeForExclusions?.rules,
  });
  return { source, where };
}

async function prepareQueryContext(deps: ExplorerDeps, params: ExplorerBaseParams): Promise<QueryContext> {
  const { getQueryDimensions, getAccountMap, getQueryProviders } = deps;
  const { startStr, endStr, windowDays, startHour, endHour } = resolveExplorerDateRange(params.dateRange, deps.now());
  // Hour bounds (sub-day drag-zoom) require the hourly tier — that's where
  // usage_hour lives. Promote tier when present, regardless of what
  // params.granularity says.
  const requestedTier: 'daily' | 'hourly' = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const tier: 'daily' | 'hourly' = (startHour !== undefined && endHour !== undefined) ? 'hourly' : requestedTier;

  // Empty while onboarding (no provider configured) — falls into the same
  // zero-period early return as "no months on disk". Months are resolved
  // ACROSS providers (the union proceeds when any provider has data in
  // range); buildFreshSource re-intersects per provider before building
  // globs.
  const providers = await getQueryProviders(tier);
  const required = computePeriodsInRange({ start: startStr, end: endStr });
  const periods = required.filter(m => providers.some(p => p.availablePeriods?.includes(m) ?? false));

  const dimensions = await getQueryDimensions();
  const accountMap = await getAccountMap();

  const tagColumns: readonly ExplorerTagColumn[] = dimensions.tags.map(t => ({
    id: tagDimColumn(t),
    label: t.label,
  }));
  const tagIdSet = new Set(tagColumns.map(t => t.id));
  const shared = { providers, startStr, endStr, windowDays, tier, tagColumns, tagIdSet, dimensions, accountMap } as const;

  if (periods.length === 0) {
    return { empty: true, source: '', where: { sql: '', params: [] }, ...shared };
  }

  const accountReverseMap = buildAccountReverseMap(accountMap);

  // Explorer always reads Parquet directly — the materialized base uses a
  // slim schema (no description, usage_amount, list_cost) that Explorer's
  // aggregated table and sample rows need.
  const { source, where } = await buildFreshSource({
    deps, params, startStr, endStr,
    ...(startHour === undefined ? {} : { startHour }),
    ...(endHour === undefined ? {} : { endHour }),
    tier, periods, providers, dimensions, accountReverseMap,
  });
  return { empty: false, source, where, ...shared };
}

/** The dashboard Table widget hits the overview with the GLOBAL cost scope and
 *  no metric override — only then does the pre-aggregated daily rollup
 *  reproduce the raw totals, so gate the rollup route on exactly that. */
function overviewUsesRollup(params: ExplorerOverviewParams, tier: 'daily' | 'hourly'): boolean {
  return tier === 'daily'
    && params.applyCostScope === true
    && params.costMetric === undefined;
}

function overviewFilterColumns(params: ExplorerOverviewParams, dimensions: DimensionsConfig): string[] {
  return Object.entries(params.filters)
    .filter(([, values]) => values.length > 0)
    .map(([dimId]) => columnForDimension(dimensions, dimId));
}

function readOverviewTotals(result: PromiseSettledResult<RawRow[]>): { totalCost: number; totalRows: number } {
  if (result.status !== 'fulfilled') {
    logger.warn(`explorer: totals query failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    return { totalCost: 0, totalRows: 0 };
  }
  const row = result.value[0];
  return { totalCost: toNum(row?.['total_cost']), totalRows: toNum(row?.['total_rows']) };
}

function parseDailyDate(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return '';
}

function readOverviewDaily(result: PromiseSettledResult<RawRow[]>): readonly ExplorerDailyRow[] {
  if (result.status !== 'fulfilled') {
    logger.warn(`explorer: daily query failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    return [];
  }
  return result.value.map(r => ({ date: parseDailyDate(r['date']), cost: toNum(r['daily_cost']), rows: toNum(r['daily_rows']) }));
}

export async function queryExplorerOverview(deps: ExplorerDeps, params: ExplorerOverviewParams): Promise<ExplorerOverviewResult> {
  const { runPreparedQuery, rollupStore, getAccountReverseMap } = deps;
  const qc = await prepareQueryContext(deps, params);

  const zero: ExplorerOverviewResult = {
    windowDays: qc.windowDays,
    startDate: qc.startStr,
    endDate: qc.endStr,
    dailyTotals: [],
    totalRows: 0,
    totalCost: 0,
    tagColumns: qc.tagColumns,
  };
  if (qc.empty) return zero;

  // Route the heavy overview scan (total cost + line-item count + daily
  // breakdown) through the pre-aggregated rollup when possible. The rollup
  // stores cost + line_items per (usage_date × grain), so SUM(cost) /
  // SUM(line_items) reproduce the raw totals without the ~900MB-1GB raw
  // Parquet scan that is the single biggest source of dashboard contention.
  // Only when this request uses the GLOBAL cost scope (the dashboard Table
  // widget): the rollup bakes the global metric and drops
  // exclusion rows at build time, so an Explorer-style request that overrides
  // the metric or skips the scope must stay on raw. Detail/expand
  // rows still hit raw — they need resource_id/description, not in the grain.
  const rollupSource = overviewUsesRollup(params, qc.tier)
    ? resolveRollupSource(rollupStore, qc.providers, { start: qc.startStr, end: qc.endStr }, 'daily', [
        'cost',
        ...overviewFilterColumns(params, qc.dimensions),
      ])
    : undefined;

  let source: string;
  let where: ParameterizedWhere;
  let rowsExpr: string;
  let bucketExpr: string;
  if (rollupSource === undefined) {
    source = qc.source;
    where = qc.where;
    rowsExpr = 'COUNT(*)';
    // Bucket width matches the queried tier — daily rows group per day,
    // hourly rows group per hour. Monthly-frequency line items (fees, Tax)
    // Refund and Tax carry a precise mid-hour timestamp; we shift by 30
    // minutes before truncating so a fee at 11:56:32 lands in the 12:00
    // bucket instead of either getting its own bar (no truncation) or being
    // stuck in 11:00 (plain truncation).
    bucketExpr = qc.tier === 'hourly' ? `date_trunc('hour', usage_hour + INTERVAL '30 minutes')` : 'usage_date';
  } else {
    // Exclusions are baked into the rollup, so only the date window + the
    // user's dashboard filters apply. line_items is the per-grain COUNT(*),
    // so SUM(line_items) equals the raw line-item count the raw path returns
    // — the overview's totalRows stays consistent with the detailed table.
    source = rollupSource;
    where = buildExplorerWhere({
      startStr: qc.startStr, endStr: qc.endStr, tier: 'daily',
      filters: params.filters, dimensions: qc.dimensions, accountReverseMap: await getAccountReverseMap(),
    });
    rowsExpr = 'COALESCE(SUM(line_items), 0)';
    bucketExpr = 'usage_date';
  }

  const totalsSql = `
    SELECT
      CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS total_cost,
      CAST(${rowsExpr} AS DOUBLE) AS total_rows
    FROM ${source}
    ${where.sql}
  `.trim();

  const dailySql = `
    SELECT
      ${bucketExpr}::VARCHAR AS date,
      CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS daily_cost,
      CAST(${rowsExpr} AS DOUBLE) AS daily_rows
    FROM ${source}
    ${where.sql}
    GROUP BY ${bucketExpr}
    ORDER BY ${bucketExpr}
  `.trim();

  // Flag rollup-backed scans as materialized in the query log, as the
  // dashboard handlers do.
  const materialized = rollupSource !== undefined;
  const [totalsResult, dailyResult] = await Promise.allSettled([
    runPreparedQuery(totalsSql, where.params, materialized),
    runPreparedQuery(dailySql, where.params, materialized),
  ]);

  const { totalCost, totalRows } = readOverviewTotals(totalsResult);
  const dailyTotals = readOverviewDaily(dailyResult);

  return {
    windowDays: qc.windowDays,
    startDate: qc.startStr,
    endDate: qc.endStr,
    dailyTotals,
    totalRows,
    totalCost,
    tagColumns: qc.tagColumns,
  };
}

export async function queryExplorerRows(deps: ExplorerDeps, params: ExplorerRowsParams): Promise<ExplorerRowsResult> {
  const { runPreparedQuery } = deps;
  const qc = await prepareQueryContext(deps, params);
  const rowLimit = clampRowLimit(params.rowLimit);

  if (qc.empty) return { sampleRows: [], tagColumns: qc.tagColumns };

  const tagSelectSql = qc.tagColumns.length > 0
    ? qc.tagColumns.map(t => `COALESCE(${t.id}, '') AS ${t.id}`).join(',\n          ')
    : null;
  const orderBy = buildOrderBy(params.sort, qc.tagIdSet);
  // Hourly tier exposes `usage_hour` as a TIMESTAMP in the source — cast
  // to VARCHAR so it survives IPC cleanly. Daily has no usage_hour
  // column, so emit a literal empty string.
  const hourSelect = qc.tier === 'hourly' ? `usage_hour::VARCHAR AS usage_hour` : `'' AS usage_hour`;
  const qb = new QueryBuilder(qc.where.params);
  const limit = qb.addParam(rowLimit);
  const sampleSql = `
    SELECT
      usage_date::VARCHAR AS usage_date,
      ${hourSelect},
      account_id, account_name, region, service, service_category,
      charge_category, operation, sku_meter, description, resource_id,
      CAST(usage_amount AS DOUBLE) AS usage_amount,
      CAST(cost AS DOUBLE) AS cost,
      CAST(list_cost AS DOUBLE) AS list_cost${tagSelectSql === null ? '' : `,\n        ${tagSelectSql}`}
    FROM ${qc.source}
    ${qc.where.sql}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `.trim();

  let sampleRows: readonly ExplorerSampleRow[] = [];
  try {
    const rows = await runPreparedQuery(sampleSql, qb.build().params);
    sampleRows = rows.map(r => {
      const tags: Record<string, string> = {};
      for (const t of qc.tagColumns) {
        const v = r[t.id];
        tags[t.id] = typeof v === 'string' ? v : '';
      }
      return {
        date: toStr(r['usage_date']),
        hour: toStr(r['usage_hour']),
        accountId: toStr(r['account_id']),
        accountName: toStr(r['account_name']),
        region: toStr(r['region']),
        service: toStr(r['service']),
        serviceCategory: toStr(r['service_category']),
        chargeCategory: toStr(r['charge_category']),
        operation: toStr(r['operation']),
        skuMeter: toStr(r['sku_meter']),
        description: toStr(r['description']),
        resourceId: toStr(r['resource_id']),
        usageAmount: toNum(r['usage_amount']),
        cost: toNum(r['cost']),
        listCost: toNum(r['list_cost']),
        tags,
      };
    });
  } catch (err) {
    logger.warn(`explorer: sample query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { sampleRows, tagColumns: qc.tagColumns };
}

export async function queryAggregatedTable(deps: ExplorerDeps, params: AggregatedTableParams): Promise<AggregatedTableResult> {
  const { runPreparedQuery } = deps;
  const qc = await prepareQueryContext(deps, params);
  const rowLimit = clampRowLimit(params.rowLimit);

  if (qc.empty) return { rows: [], totalRows: 0, tagColumns: qc.tagColumns };

  const where = appendRowFilters(qc.where, params.rowFilters, qc.tagIdSet);

  const groupByColumns = params.groupByColumns.filter(
    col => EXPLORER_SCALAR_COLUMNS.has(col) || qc.tagIdSet.has(col),
  );

  if (groupByColumns.length === 0) {
    const sql = `
      SELECT
        CAST(SUM(cost) AS DOUBLE) AS cost,
        CAST(SUM(list_cost) AS DOUBLE) AS list_cost,
        CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount,
        CAST(COUNT(*) AS DOUBLE) AS row_count
      FROM ${qc.source}
      ${where.sql}
    `.trim();
    const rows = await runPreparedQuery(sql, where.params);
    const r = rows[0];
    if (r === undefined) return { rows: [], totalRows: 0, tagColumns: qc.tagColumns };
    return {
      rows: [{ values: {}, cost: toNum(r['cost']), listCost: toNum(r['list_cost']), usageAmount: toNum(r['usage_amount']), rowCount: toNum(r['row_count']) }],
      totalRows: 1,
      tagColumns: qc.tagColumns,
    };
  }

  const selectCols = groupByColumns.map(col => {
    if (col === 'usage_date') return `usage_date::VARCHAR AS usage_date`;
    return col;
  });
  const orderBy = resolveAggregatedSort(params.sort, groupByColumns);
  const qb = new QueryBuilder(where.params);
  const limit = qb.addParam(rowLimit);

  const countSql = `
    SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM (
      SELECT 1 FROM ${qc.source} ${where.sql}
      GROUP BY ${groupByColumns.join(', ')}
    ) AS _cnt
  `.trim();
  const dataSql = `
    SELECT
      ${selectCols.join(', ')},
      CAST(SUM(cost) AS DOUBLE) AS cost,
      CAST(SUM(list_cost) AS DOUBLE) AS list_cost,
      CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount,
      CAST(COUNT(*) AS DOUBLE) AS row_count
    FROM ${qc.source}
    ${where.sql}
    GROUP BY ${groupByColumns.join(', ')}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `.trim();

  const [countResult, dataResult] = await Promise.all([
    runPreparedQuery(countSql, where.params),
    runPreparedQuery(dataSql, qb.build().params),
  ]);
  const totalRows = countResult[0] === undefined ? 0 : toNum(countResult[0]['n']);
  const resultRows: AggregatedTableRow[] = dataResult.map(r => {
    const values: Record<string, string> = {};
    for (const col of groupByColumns) {
      values[col] = toStr(r[col]);
    }
    return {
      values,
      cost: toNum(r['cost']),
      listCost: toNum(r['list_cost']),
      usageAmount: toNum(r['usage_amount']),
      rowCount: toNum(r['row_count']),
    };
  });

  return { rows: resultRows, totalRows, tagColumns: qc.tagColumns };
}

export async function queryExplorerFilterValues(deps: ExplorerDeps, params: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]> {
  const { runPreparedQuery } = deps;
  const dimId = params.dimensionId;

  // Exclude the current dim from the filter set — opening a dim's dropdown
  // should show *all* values that remain under the other filters, not
  // just the ones already picked. Standard facet-browsing behaviour.
  const withoutSelf: ExplorerFilterMap = Object.fromEntries(
    Object.entries(params.filters).filter(([k]) => k !== dimId),
  );

  const qc = await prepareQueryContext(deps, { ...params, filters: withoutSelf });
  if (qc.empty) return [];

  // Throws SecurityError for ids that match neither a built-in nor a tag
  // dimension — a renderer-supplied id must never reach the SQL verbatim.
  const { fieldExpr } = resolveField(asDimensionId(dimId), qc.dimensions);

  const sql = `
    SELECT ${fieldExpr} AS val,
           CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS total_cost,
           CAST(COUNT(*) AS DOUBLE) AS row_count
    FROM ${qc.source}
    ${qc.where.sql}
    GROUP BY val
    HAVING val IS NOT NULL AND val != ''
    ORDER BY total_cost DESC
    LIMIT 500
  `.trim();

  const rows = await runPreparedQuery(sql, qc.where.params);
  const isAccountDim = dimId === 'account' || dimId === 'account_id';
  if (isAccountDim) {
    const merged = new Map<string, { cost: number; rows: number }>();
    for (const r of rows) {
      const rawVal = toStr(r['val']);
      const name = qc.accountMap.get(rawVal) ?? rawVal;
      const existing = merged.get(name);
      if (existing === undefined) merged.set(name, { cost: toNum(r['total_cost']), rows: toNum(r['row_count']) });
      else {
        existing.cost += toNum(r['total_cost']);
        existing.rows += toNum(r['row_count']);
      }
    }
    return [...merged.entries()]
      .map(([name, d]) => ({ value: name, label: name, cost: d.cost, rows: d.rows }))
      .sort((a, b) => b.cost - a.cost);
  }
  return rows.map(r => {
    const rawVal = toStr(r['val']);
    return {
      value: rawVal,
      label: rawVal,
      cost: toNum(r['total_cost']),
      rows: toNum(r['row_count']),
    };
  });
}
