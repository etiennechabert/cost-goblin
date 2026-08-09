import { ipcMain } from 'electron';
import { originStore } from '../query-log.js';
import {
  asDimensionId,
  dimensionIdSet,
  assertHourString,
  buildSource,
  buildRuleMatchExpr,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  logger,
  resolveField,
  tagDimColumn,
} from '@costgoblin/core';
import type {
  ExclusionRule,
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
  ExplorerSort,
  ExplorerDailyRow,
  ExplorerTagColumn,
  DimensionsConfig,
  ProviderSourceSpec,
  AggregatedTableParams,
  AggregatedTableRow,
  AggregatedTableResult,
} from '@costgoblin/core';
import type { RawRow } from '../duckdb-client.js';
import { type AppContext, prefsPath } from './context.js';
import { buildAccountReverseMap, columnForDimension, resolveRollupSource, toNum, toStr } from './query-utils.js';
import { readExplorerPreferences, writeExplorerPreferences } from './explorer-prefs.js';
import { resolveScopeMetric } from './explorer-scope.js';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_ROW_LIMIT = 1000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s: string | undefined): Date | null {
  if (s === undefined || !ISO_DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ResolvedDateRange {
  readonly startStr: string;
  readonly endStr: string;
  readonly windowDays: number;
  readonly startHour?: string;
  readonly endHour?: string;
}

function resolveDateRange(raw: { start?: string | undefined; end?: string | undefined; startHour?: string | undefined; endHour?: string | undefined } | undefined): ResolvedDateRange {
  const start = parseDate(raw?.start);
  const end = parseDate(raw?.end);
  if (start !== null && end !== null && start.getTime() <= end.getTime()) {
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    const base = { startStr: toIsoDate(start), endStr: toIsoDate(end), windowDays: days };
    // Hour bounds are an additive refinement from drag-zoom on the histogram.
    // Validate up front so a malformed value can't reach the SQL builder.
    if (typeof raw?.startHour === 'string' && typeof raw.endHour === 'string') {
      try {
        assertHourString(raw.startHour);
        assertHourString(raw.endHour);
        return { ...base, startHour: raw.startHour, endHour: raw.endHour };
      } catch {
        // fall through to day-only range
      }
    }
    return base;
  }
  const latestDate = new Date(Date.now() - DEFAULT_LAG_DAYS * 86_400_000);
  const fallbackEnd = toIsoDate(latestDate);
  const fallbackStart = toIsoDate(new Date(latestDate.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 86_400_000));
  return { startStr: fallbackStart, endStr: fallbackEnd, windowDays: DEFAULT_WINDOW_DAYS };
}

const SORTABLE_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
  'usage_date',
  'usage_hour',
  'account_id',
  'account_name',
  'region',
  'service',
  'service_code',
  'service_category',
  'charge_category',
  'pricing_category',
  'commitment_status',
  'operation',
  'sku_meter',
  'description',
  'resource_id',
  'usage_amount',
  'cost',
  'list_cost',
]);

function clampRowLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(Math.floor(n), MAX_ROW_LIMIT);
}

function buildExplorerFilterPredicate(
  filters: ExplorerFilterMap,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]>,
): string | null {
  const conditions = Object.entries(filters)
    .filter(([, values]) => values.length > 0)
    .map(([dimId, values]) => ({
      dimensionId: asDimensionId(dimId),
      values,
    }));
  if (conditions.length === 0) return null;
  const synthetic: ExclusionRule = {
    id: '_explorer_filters',
    name: '_explorer_filters',
    enabled: true,
    builtIn: false,
    conditions,
  };
  return buildRuleMatchExpr(synthetic, dimensions, accountReverseMap);
}

function buildOrderBy(
  sort: ExplorerSort | undefined,
  tagColumnIds: ReadonlySet<string>,
): string {
  if (sort === undefined) return 'ABS(cost) DESC';
  const dir = sort.direction === 'asc' ? 'ASC' : 'DESC';
  if (SORTABLE_SCALAR_COLUMNS.has(sort.column) || tagColumnIds.has(sort.column)) {
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
  readonly whereStr: string;
  readonly startStr: string;
  readonly endStr: string;
  readonly windowDays: number;
  readonly tier: 'daily' | 'hourly';
  readonly tagColumns: readonly ExplorerTagColumn[];
  readonly tagIdSet: ReadonlySet<string>;
  readonly dimensions: DimensionsConfig;
  readonly accountMap: ReadonlyMap<string, string>;
}

function classifyExclusionRule(
  rule: ExclusionRule,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]>,
  singleByDim: Map<string, { fieldExpr: string; values: string[] }>,
): ExclusionRule | null {
  if (rule.conditions.length !== 1) return rule;

  const cond = rule.conditions[0];
  if (cond === undefined || cond.values.length === 0) return null;

  const key = cond.dimensionId;
  const existing = singleByDim.get(key);
  if (existing !== undefined) {
    existing.values.push(...cond.values.map(v => v.replaceAll("'", "''")));
    return null;
  }

  const probe: ExclusionRule = { ...rule, conditions: [cond] };
  const expr = buildRuleMatchExpr(probe, dimensions, accountReverseMap);
  if (expr === null) return null;

  const inIdx = expr.indexOf(' IN (');
  if (inIdx === -1) return rule;

  const fieldExpr = expr.slice(0, inIdx);
  singleByDim.set(key, { fieldExpr, values: cond.values.map(v => v.replaceAll("'", "''")) });
  return null;
}

function buildExclusionClauses(
  costScope: { rules: readonly ExclusionRule[] } | undefined,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (costScope === undefined) return [];

  const singleByDim = new Map<string, { fieldExpr: string; values: string[] }>();
  const multiRules: ExclusionRule[] = [];

  for (const rule of costScope.rules) {
    if (!rule.enabled) continue;
    const multi = classifyExclusionRule(rule, dimensions, accountReverseMap, singleByDim);
    if (multi !== null) multiRules.push(multi);
  }

  const clauses: string[] = [];
  for (const [, { fieldExpr, values }] of singleByDim) {
    const list = values.map(v => `'${v}'`).join(', ');
    clauses.push(`${fieldExpr} NOT IN (${list})`);
  }
  for (const rule of multiRules) {
    const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
    if (matchExpr !== null) clauses.push(`NOT (${matchExpr})`);
  }
  return clauses;
}

interface BuildFreshSourceOptions {
  readonly app: AppContext;
  readonly params: ExplorerBaseParams;
  readonly startStr: string;
  readonly endStr: string;
  readonly startHour?: string;
  readonly endHour?: string;
  readonly tier: 'daily' | 'hourly';
  readonly periods: readonly string[];
  readonly providers: readonly ProviderSourceSpec[];
  readonly dimensions: DimensionsConfig;
  readonly filterPredicate: string | null;
  readonly accountReverseMap: ReadonlyMap<string, readonly string[]>;
}

async function buildFreshSource(opts: BuildFreshSourceOptions): Promise<{ source: string; whereStr: string }> {
  const { app, params, startStr, endStr, startHour, endHour, tier, periods, providers, dimensions, filterPredicate, accountReverseMap } = opts;
  const { ctx, getCostScope, getOrgAccountsPath } = app;
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
    dataDir: ctx.dataDir, tier, dimensions, orgAccountsPath: orgPath,
    providers: branches,
    costMetric: metric, marketplaceAttribution: fullScope?.marketplaceAttribution,
  });
  const exclusions = buildExclusionClauses(scopeForExclusions, dimensions, accountReverseMap);

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
  const { getQueryDimensions, getAccountMap, getQueryProviders } = app;
  const { startStr, endStr, windowDays, startHour, endHour } = resolveDateRange(params.dateRange);
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
    tier, periods, providers, dimensions, filterPredicate, accountReverseMap,
  });
  return { empty: false, source, whereStr, ...shared };
}

function appendRowFilters(
  baseWhere: string,
  rowFilters: Record<string, string> | undefined,
  tagIdSet: ReadonlySet<string>,
): string {
  if (rowFilters === undefined) return baseWhere;
  const extra: string[] = [];
  for (const [col, val] of Object.entries(rowFilters)) {
    if (val.length === 0) continue;
    if (!SORTABLE_SCALAR_COLUMNS.has(col) && !tagIdSet.has(col)) continue;
    const escaped = val.replaceAll("'", "''");
    const colExpr = col === 'usage_date' ? `usage_date::VARCHAR` : col;
    extra.push(`${colExpr} = '${escaped}'`);
  }
  if (extra.length === 0) return baseWhere;
  const joined = extra.join(' AND ');
  if (baseWhere.length === 0) return `WHERE ${joined}`;
  return `${baseWhere} AND ${joined}`;
}

const AGG_SORT_COLUMNS: Record<string, (dir: string) => string> = {
  cost: (dir) => `SUM(cost) ${dir}`,
  list_cost: (dir) => `SUM(list_cost) ${dir}`,
  usage_amount: (dir) => `SUM(usage_amount) ${dir}`,
  row_count: (dir) => `COUNT(*) ${dir}`,
};

function resolveAggregatedSort(sort: ExplorerSort | undefined, groupByColumns: readonly string[]): string {
  if (sort === undefined) return 'SUM(cost) DESC';
  const dir = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const fn = AGG_SORT_COLUMNS[sort.column];
  if (fn !== undefined) return fn(dir);
  if (groupByColumns.includes(sort.column)) return `${sort.column} ${dir}`;
  return 'SUM(cost) DESC';
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

export function registerExplorerHandlers(app: AppContext): void {
  const { ctx, runQuery, rollupStore, getAccountReverseMap, getQueryDimensions } = app;

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
      bucketExpr = qc.tier === 'hourly' ? `date_trunc('hour', usage_hour + INTERVAL '30 minutes')` : 'usage_date';
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
      bucketExpr = 'usage_date';
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

    const tagSelectSql = qc.tagColumns.length > 0
      ? qc.tagColumns.map(t => `COALESCE(${t.id}, '') AS ${t.id}`).join(',\n          ')
      : null;
    const orderBy = buildOrderBy(params.sort, qc.tagIdSet);
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
        CAST(list_cost AS DOUBLE) AS list_cost${tagSelectSql === null ? '' : `,\n        ${tagSelectSql}`}
      FROM ${qc.source}
      ${qc.whereStr}
      ORDER BY ${orderBy}
      LIMIT ${String(rowLimit)}
    `.trim();

    let sampleRows: readonly ExplorerSampleRow[] = [];
    try {
      const rows = await runQuery(sampleSql);
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
  }));

  ipcMain.handle('explorer:query-aggregated-table', (_event, payload: unknown): Promise<AggregatedTableResult> => originStore.run((payload as AggregatedTableParams).origin ?? null, async () => {
    const params = payload as AggregatedTableParams;
    const qc = await prepareQueryContext(app, params);
    const rowLimit = clampRowLimit(params.rowLimit);

    if (qc.empty) return { rows: [], totalRows: 0, tagColumns: qc.tagColumns };

    const whereStr = appendRowFilters(qc.whereStr, params.rowFilters, qc.tagIdSet);

    const groupByColumns = params.groupByColumns.filter(
      col => SORTABLE_SCALAR_COLUMNS.has(col) || qc.tagIdSet.has(col),
    );

    if (groupByColumns.length === 0) {
      const sql = `
        SELECT
          CAST(SUM(cost) AS DOUBLE) AS cost,
          CAST(SUM(list_cost) AS DOUBLE) AS list_cost,
          CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount,
          CAST(COUNT(*) AS DOUBLE) AS row_count
        FROM ${qc.source}
        ${whereStr}
      `.trim();
      const rows = await runQuery(sql);
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

    const countSql = `
      SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM (
        SELECT 1 FROM ${qc.source} ${whereStr}
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
      ${whereStr}
      GROUP BY ${groupByColumns.join(', ')}
      ORDER BY ${orderBy}
      LIMIT ${String(rowLimit)}
    `.trim();

    const [countResult, dataResult] = await Promise.all([runQuery(countSql), runQuery(dataSql)]);
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
  }));

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
