import { ipcMain } from 'electron';
import { originStore } from '../query-log.js';
import {
  asDimensionId,
  dimensionIdSet,
  buildExclusionClauses,
  buildSource,
  freshnessCutoff,
  isStringRecord,
  logger,
  providerBranchesForRange,
  resolveField,
  SecurityError,
  tagDimColumn,
  tagSqlColumnsById,
  usageDateBucketExpr,
} from '@costgoblin/core';
import type {
  ExplorerBaseParams,
  ExplorerFilterMap,
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerPreferencesUpdate,
  ExplorerRowsParams,
  ExplorerRowsResult,
  ExplorerSampleRow,
  ExplorerDailyRow,
  ExplorerTagColumn,
  DimensionsConfig,
  ProviderSourceBranch,
  ProviderSourceSpec,
  AggregatedGroupCountParams,
  AggregatedTableParams,
  AggregatedTableResult,
} from '@costgoblin/core';
import type { RawRow } from '../duckdb-client.js';
import { type AppContext, prefsPath } from './context.js';
import { buildAccountReverseMap, columnForDimension, resolveRollupSource, tagSelectItems, tagValuesById, toNum, toStr } from './query-utils.js';
import { countAggregatedGroups, parseRowFilters, parseRowKeys, queryAggregatedRows } from './aggregated-table.js';
import type { RunSql } from './aggregated-table.js';
import { explorerGroupBy, explorerOrderBy, explorerRowFilters } from './explorer-columns.js';
import { buildExplorerFilterPredicate } from './explorer-filters.js';
import { readExplorerPreferences, writeExplorerPreferences } from './explorer-prefs.js';
import { queryResourceRollupTable } from './resource-table.js';
import { resolveScopeMetric } from './explorer-scope.js';
import { capResolvedRange, resolveExplorerDateRange } from './query-windows.js';

const MAX_ROW_LIMIT = 1000;

function clampRowLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(Math.floor(n), MAX_ROW_LIMIT);
}

/** Everything the overview / rows / filter-values handlers compute up front.
 *  `empty === true` when no matching months are on disk — caller returns a
 *  zero-filled result without bothering DuckDB. */
interface QueryContext {
  readonly empty: boolean;
  readonly providers: readonly ProviderSourceSpec[];
  readonly source: string;
  readonly whereStr: string;
  readonly startStr: string;
  readonly endStr: string;
  readonly windowDays: number;
  readonly tier: 'daily' | 'hourly';
  readonly tagColumns: readonly ExplorerTagColumn[];
  /** Tag id → SQL column; see tagSqlColumnsById. */
  readonly tagSqlColumns: ReadonlyMap<string, string>;
  readonly dimensions: DimensionsConfig;
  readonly accountMap: ReadonlyMap<string, string>;
}

interface BuildFreshSourceOptions {
  readonly app: AppContext;
  readonly params: ExplorerBaseParams;
  readonly startStr: string;
  readonly endStr: string;
  readonly startHour?: string;
  readonly endHour?: string;
  readonly tier: 'daily' | 'hourly';
  readonly branches: readonly ProviderSourceBranch[];
  readonly dimensions: DimensionsConfig;
  readonly filterPredicate: string | null;
  readonly accountReverseMap: ReadonlyMap<string, readonly string[]>;
}

async function buildFreshSource(opts: BuildFreshSourceOptions): Promise<{ source: string; whereStr: string }> {
  const { app, params, startStr, endStr, startHour, endHour, tier, branches, dimensions, filterPredicate, accountReverseMap } = opts;
  const { ctx, getQueryCostScope, getOrgAccountsPath } = app;
  const orgPath = await getOrgAccountsPath();
  const applyCostScope = params.applyCostScope === true;
  // Marketplace re-attribution fixes which service a cost belongs to (a data
  // quality fix, not an exclusion), so it follows its own toggle and applies
  // regardless of the "Apply Cost Scope" checkbox — otherwise the Explorer and
  // its filter dropdowns would disagree with the dashboard on Bedrock spend.
  const fullScope = await getQueryCostScope();
  const scopeForExclusions = applyCostScope ? fullScope : undefined;
  // When the caller applies the cost scope but doesn't override the metric
  // (every dashboard widget — only the Explorer view sets it explicitly),
  // inherit it from the global scope instead of silently defaulting.
  const metric = resolveScopeMetric(params.costMetric, applyCostScope, scopeForExclusions);

  const source = buildSource({
    dataDir: ctx.dataDir, tier, dimensions, orgAccountsPath: orgPath,
    providers: branches,
    costMetric: metric, marketplaceAttribution: fullScope.marketplaceAttribution,
  });
  const exclusions = scopeForExclusions === undefined ? [] : buildExclusionClauses(scopeForExclusions.rules, dimensions, accountReverseMap);

  // When the histogram drag-zoom emits hour bounds, swap the day-level
  // BETWEEN for an hour-level filter so the rest of the Explorer (overview,
  // table, sample rows) matches what the user dragged. usage_hour only exists
  // on the hourly tier — caller forces tier='hourly' in that case.
  const dateClause = startHour !== undefined && endHour !== undefined && tier === 'hourly'
    ? `usage_hour BETWEEN TIMESTAMP '${startHour}' AND TIMESTAMP '${endHour}'`
    : `usage_date BETWEEN '${startStr}' AND '${endStr}'`;

  const whereClauses: string[] = [
    dateClause,
    ...(filterPredicate === null ? [] : [`(${filterPredicate})`]),
    ...exclusions,
  ];
  return { source, whereStr: `WHERE ${whereClauses.join(' AND ')}` };
}

async function prepareQueryContext(app: AppContext, params: ExplorerBaseParams): Promise<QueryContext> {
  const { getQueryDimensions, getAccountMap, getQueryCostScope, getQueryProviders } = app;
  const nowMs = app.ctx.now();
  const { lagDays } = await getQueryCostScope();
  const requested = resolveExplorerDateRange(params.dateRange, nowMs, lagDays);
  // The freshness lag is part of the cost scope: with "Apply cost scope" off,
  // the Explorer reads the newest days too.
  const resolved = params.applyCostScope === true
    ? capResolvedRange(requested, freshnessCutoff(nowMs, lagDays))
    : requested;
  const { startStr, endStr, windowDays, startHour, endHour } = resolved ?? requested;
  // Hour bounds (sub-day drag-zoom) require the hourly tier — that's where
  // usage_hour lives. Promote tier when present, regardless of what
  // params.granularity says.
  const requestedTier: 'daily' | 'hourly' = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const tier: 'daily' | 'hourly' = (startHour !== undefined && endHour !== undefined) ? 'hourly' : requestedTier;

  // Empty while onboarding (no provider configured) — falls into the same
  // zero-period early return as "no months on disk". The billing periods
  // holding a day of the range are worked out PER provider: a shared list
  // would hand a provider globs for months it doesn't have on disk, and one
  // zero-match glob fails the whole union (DuckDB IO error). Providers with
  // nothing in range are dropped; the union proceeds when any has data.
  const providers = await getQueryProviders(tier);
  const branches = providerBranchesForRange(providers, { start: startStr, end: endStr });

  const dimensions = await getQueryDimensions();
  const accountMap = await getAccountMap();

  const tagColumns: readonly ExplorerTagColumn[] = dimensions.tags.map(t => ({
    id: tagDimColumn(t),
    label: t.label,
  }));
  const tagSqlColumns = tagSqlColumnsById(dimensions.tags);
  const shared = { providers, startStr, endStr, windowDays, tier, tagColumns, tagSqlColumns, dimensions, accountMap } as const;

  if (resolved === null || branches.length === 0) {
    return { empty: true, source: '', whereStr: '', ...shared };
  }

  const accountReverseMap = buildAccountReverseMap(accountMap);
  const filterPredicate = buildExplorerFilterPredicate(params.filters, dimensions, accountReverseMap);

  // Explorer always reads Parquet directly — the materialized base uses a
  // slim schema (no description, usage_amount, list_cost) that Explorer's
  // aggregated table and sample rows need.
  const { source, whereStr } = await buildFreshSource({
    app, params, startStr, endStr,
    ...(startHour === undefined ? {} : { startHour }),
    ...(endHour === undefined ? {} : { endHour }),
    tier, branches, dimensions, filterPredicate, accountReverseMap,
  });
  return { empty: false, source, whereStr, ...shared };
}

/** A group-count request with the fields its SQL is built from in the shape
 *  the builders expect. The date range, the row filters and the options are
 *  checked where they are read (`resolveExplorerDateRange`, `parseRowFilters`). */
function isGroupCountParams(raw: unknown): raw is AggregatedGroupCountParams {
  if (!isStringRecord(raw)) return false;
  const { filters, groupByColumns, origin } = raw;
  const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
  return isStringRecord(filters)
    && Object.values(filters).every(isStrings)
    && isStrings(groupByColumns)
    && (origin === undefined || typeof origin === 'string');
}

/** True when a request applies the saved cost scope with its own metric, as
 *  every dashboard widget does: the only numbers a rollup holds, since it
 *  bakes that metric in and drops the excluded rows at build time. */
function usesSavedScope(params: ExplorerBaseParams): boolean {
  return params.applyCostScope === true && params.costMetric === undefined;
}

/** The dashboard Table widget hits the overview with the GLOBAL cost scope and
 *  no metric override — only then does the pre-aggregated daily rollup
 *  reproduce the raw totals, so gate the rollup route on exactly that. */
function overviewUsesRollup(params: ExplorerOverviewParams, tier: 'daily' | 'hourly'): boolean {
  return tier === 'daily' && usesSavedScope(params);
}

function overviewFilterColumns(params: ExplorerBaseParams, dimensions: DimensionsConfig): string[] {
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

export function registerExplorerHandlers(app: AppContext): void {
  const { ctx, runQuery, runPreparedQuery, rollupStore, resourceRollupStore, getAccountReverseMap, getQueryDimensions } = app;

  const explorerPrefsPath = () => prefsPath(ctx.stateDir, 'explorer-preferences');

  ipcMain.handle('explorer:get-preferences', async (): Promise<ExplorerPreferences> =>
    readExplorerPreferences(
      await explorerPrefsPath(),
      () => getQueryDimensions().then(dimensionIdSet, () => undefined),
    ));

  ipcMain.handle('explorer:save-preferences', async (_event, prefs: ExplorerPreferencesUpdate): Promise<void> => {
    await writeExplorerPreferences(await explorerPrefsPath(), prefs);
  });

  // Histogram + totals. Depends on filters/range/granularity/scope/metric/
  // perspective — NOT on sort. Kept separate from the rows query so that
  // clicking a column header doesn't wipe the histogram.
  ipcMain.handle('explorer:query-overview', (_event, payload: unknown): Promise<ExplorerOverviewResult> => originStore.run((payload as ExplorerOverviewParams).origin ?? null, async () => {
    const params = payload as ExplorerOverviewParams;
    const qc = await prepareQueryContext(app, params);

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
    let whereStr: string;
    let rowsExpr: string;
    let bucketExpr: string;
    if (rollupSource === undefined) {
      source = qc.source;
      whereStr = qc.whereStr;
      rowsExpr = 'COUNT(*)';
      // Bucket width matches the queried tier — daily rows group per day,
      // hourly rows group per hour. Monthly-frequency line items (fees, Tax)
      // Refund and Tax carry a precise mid-hour timestamp; we shift by 30
      // minutes before truncating so a fee at 11:56:32 lands in the 12:00
      // bucket instead of either getting its own bar (no truncation) or being
      // stuck in 11:00 (plain truncation).
      bucketExpr = qc.tier === 'hourly' ? `date_trunc('hour', usage_hour + INTERVAL '30 minutes')` : usageDateBucketExpr(params.granularity);
    } else {
      // Exclusions are baked into the rollup, so only the date window + the
      // user's dashboard filters apply. line_items is the per-grain COUNT(*),
      // so SUM(line_items) equals the raw line-item count the raw path returns
      // — the overview's totalRows stays consistent with the detailed table.
      const filterPredicate = buildExplorerFilterPredicate(params.filters, qc.dimensions, await getAccountReverseMap());
      const filterClause = filterPredicate === null ? '' : ` AND (${filterPredicate})`;
      source = rollupSource;
      whereStr = `WHERE usage_date BETWEEN '${qc.startStr}' AND '${qc.endStr}'${filterClause}`;
      rowsExpr = 'COALESCE(SUM(line_items), 0)';
      // The rollup is daily-grained, so weekly/monthly buckets its days too.
      bucketExpr = usageDateBucketExpr(params.granularity);
    }

    const totalsSql = `
      SELECT
        CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS total_cost,
        CAST(${rowsExpr} AS DOUBLE) AS total_rows
      FROM ${source}
      ${whereStr}
    `.trim();

    const dailySql = `
      SELECT
        ${bucketExpr}::VARCHAR AS date,
        CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS daily_cost,
        CAST(${rowsExpr} AS DOUBLE) AS daily_rows
      FROM ${source}
      ${whereStr}
      GROUP BY ${bucketExpr}
      ORDER BY ${bucketExpr}
    `.trim();

    const [totalsResult, dailyResult] = await Promise.allSettled([
      runQuery(totalsSql),
      runQuery(dailySql),
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
  }));

  // Sample rows. Depends on everything the overview does PLUS sort + rowLimit.
  ipcMain.handle('explorer:query-rows', (_event, payload: unknown): Promise<ExplorerRowsResult> => originStore.run((payload as ExplorerRowsParams).origin ?? null, async () => {
    const params = payload as ExplorerRowsParams;
    const qc = await prepareQueryContext(app, params);
    const rowLimit = clampRowLimit(params.rowLimit);

    if (qc.empty) return { sampleRows: [], tagColumns: qc.tagColumns };

    const tagSelects = tagSelectItems(qc.tagSqlColumns);
    const orderBy = explorerOrderBy(params.sort, qc.tagSqlColumns);
    // Hourly tier exposes `usage_hour` as a TIMESTAMP in the source — cast
    // to VARCHAR so it survives IPC cleanly. Daily has no usage_hour
    // column, so emit a literal empty string.
    const hourSelect = qc.tier === 'hourly' ? `usage_hour::VARCHAR AS usage_hour` : `'' AS usage_hour`;
    const sampleSql = `
      SELECT
        usage_date::VARCHAR AS usage_date,
        ${hourSelect},
        account_id, account_name, region, service, service_category,
        charge_category, operation, sku_meter, description, resource_id,
        CAST(usage_amount AS DOUBLE) AS usage_amount,
        CAST(cost AS DOUBLE) AS cost,
        CAST(list_cost AS DOUBLE) AS list_cost${tagSelects.length === 0 ? '' : `,\n        ${tagSelects.join(',\n        ')}`}
      FROM ${qc.source}
      ${qc.whereStr}
      ORDER BY ${orderBy}
      LIMIT ${String(rowLimit)}
    `.trim();

    let sampleRows: readonly ExplorerSampleRow[] = [];
    try {
      const rows = await runQuery(sampleSql);
      sampleRows = rows.map(r => ({
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
        tags: tagValuesById(r, qc.tagSqlColumns),
      }));
    } catch (err) {
      logger.warn(`explorer: sample query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { sampleRows, tagColumns: qc.tagColumns };
  }));

  // Without row filters or keys the queries take no parameters, so they keep the plain path.
  const runAggregatedSql: RunSql = (sql, bound) => bound.length === 0 ? runQuery(sql) : runPreparedQuery(sql, bound);

  ipcMain.handle('explorer:query-aggregated-table', (_event, payload: unknown): Promise<AggregatedTableResult> => originStore.run((payload as AggregatedTableParams).origin ?? null, async () => {
    const params = payload as AggregatedTableParams;
    const rowFilters = parseRowFilters(params.rowFilters);
    const rowKeys = parseRowKeys(params.rowKeys, MAX_ROW_LIMIT);
    const qc = await prepareQueryContext(app, params);

    if (qc.empty) return { rows: [], totalRows: 0, tagColumns: qc.tagColumns };

    const groupBy = explorerGroupBy(params.groupByColumns, qc.tagSqlColumns, params.granularity);
    const query = {
      groupBy,
      rowFilters: explorerRowFilters(rowFilters, qc.tagSqlColumns, params.granularity),
      sort: params.sort,
      rowLimit: clampRowLimit(params.rowLimit),
      rowKeys,
    };
    // A table grouped by resource and description reads the resource rollup
    // when that gives the rows raw Parquet would: grouping every line item
    // of a large bill by them takes a minute or more.
    const rolled = await queryResourceRollupTable(runAggregatedSql, {
      ...query,
      store: resourceRollupStore,
      providers: qc.providers,
      dateRange: { start: qc.startStr, end: qc.endStr },
      tier: qc.tier,
      usesSavedScope: usesSavedScope(params),
      filterPredicate: buildExplorerFilterPredicate(params.filters, qc.dimensions, await getAccountReverseMap()),
      filterColumns: overviewFilterColumns(params, qc.dimensions),
      deferTotalRows: params.deferTotalRows === true,
    });
    if (rolled !== null) return { ...rolled, tagColumns: qc.tagColumns };

    const { rows, totalRows } = await queryAggregatedRows(runAggregatedSql, { ...query, source: qc.source, where: qc.whereStr });
    return { rows, totalRows, tagColumns: qc.tagColumns };
  }));

  // How many groups an aggregated table has: asked on its own when the page
  // came without it (`deferTotalRows`), so the rows never wait for it.
  ipcMain.handle('explorer:count-aggregated-groups', (_event, payload: unknown): Promise<number> => {
    if (!isGroupCountParams(payload)) return Promise.reject(new SecurityError('explorer:count-aggregated-groups: malformed request'));
    const params = payload;
    return originStore.run(params.origin ?? null, async () => {
      const rowFilters = parseRowFilters(params.rowFilters);
      const qc = await prepareQueryContext(app, params);
      if (qc.empty) return 0;
      return countAggregatedGroups(runAggregatedSql, {
        source: qc.source,
        where: qc.whereStr,
        groupBy: explorerGroupBy(params.groupByColumns, qc.tagSqlColumns, params.granularity),
        rowFilters: explorerRowFilters(rowFilters, qc.tagSqlColumns, params.granularity),
      });
    });
  });

  ipcMain.handle('explorer:filter-values', (_event, payload: unknown): Promise<ExplorerFilterValue[]> => originStore.run((payload as ExplorerFilterValuesParams).origin ?? null, async () => {
    const params = payload as ExplorerFilterValuesParams;
    const dimId = params.dimensionId;

    // Exclude the current dim from the filter set — opening a dim's dropdown
    // should show *all* values that remain under the other filters, not
    // just the ones already picked. Standard facet-browsing behaviour.
    const withoutSelf: ExplorerFilterMap = Object.fromEntries(
      Object.entries(params.filters).filter(([k]) => k !== dimId),
    );

    const qc = await prepareQueryContext(app, { ...params, filters: withoutSelf });
    if (qc.empty) return [];

    // Throws SecurityError for ids that match neither a built-in nor a tag
    // dimension — a renderer-supplied id must never reach the SQL verbatim.
    const { fieldExpr } = resolveField(asDimensionId(dimId), qc.dimensions);

    const sql = `
      SELECT ${fieldExpr} AS val,
             CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS total_cost,
             CAST(COUNT(*) AS DOUBLE) AS row_count
      FROM ${qc.source}
      ${qc.whereStr}
      GROUP BY val
      HAVING val IS NOT NULL AND val != ''
      ORDER BY total_cost DESC
      LIMIT 500
    `.trim();

    const rows = await runQuery(sql);
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
  }));
}
