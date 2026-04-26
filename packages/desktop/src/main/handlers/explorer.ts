import { ipcMain } from 'electron';
import {
  asDimensionId,
  buildSource,
  buildRuleMatchExpr,
  buildAliasSqlCase,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  logger,
  listLocalMonths,
  parseJsonObject,
  tagColumnName,
} from '@costgoblin/core';
import type {
  CostMetric,
  CostPerspective,
  ExclusionRule,
  ExplorerBaseParams,
  ExplorerFilterMap,
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerRowsParams,
  ExplorerRowsResult,
  ExplorerSampleRow,
  ExplorerSort,
  ExplorerDailyRow,
  ExplorerTagColumn,
  DimensionsConfig,
  AggregatedTableParams,
  AggregatedTableRow,
  AggregatedTableResult,
} from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';
import { buildAccountReverseMap, toNum, toStr } from './query-utils.js';

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

function resolveDateRange(raw: { start?: string; end?: string } | undefined): { startStr: string; endStr: string; windowDays: number } {
  const start = parseDate(raw?.start);
  const end = parseDate(raw?.end);
  if (start !== null && end !== null && start.getTime() <= end.getTime()) {
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    return { startStr: toIsoDate(start), endStr: toIsoDate(end), windowDays: days };
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
  'service_family',
  'line_item_type',
  'operation',
  'usage_type',
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

function pickMetric(metric: CostMetric | undefined, cols: ReadonlySet<string>): CostMetric {
  if (metric === 'amortized' && cols.has('reservation_effective_cost') && cols.has('savings_plan_savings_plan_effective_cost')) return 'amortized';
  if (metric === 'blended' && cols.has('line_item_blended_cost')) return 'blended';
  return 'unblended';
}

function pickPerspective(p: CostPerspective | undefined, cols: ReadonlySet<string>): CostPerspective {
  if (p === 'net' && cols.has('line_item_net_unblended_cost')) return 'net';
  return 'gross';
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

async function prepareQueryContext(app: AppContext, params: ExplorerBaseParams): Promise<QueryContext> {
  const { ctx, getCostScope, getQueryDimensions, getOrgAccountsPath, getAvailableColumns, getAccountMap } = app;
  const { startStr, endStr, windowDays } = resolveDateRange(params.dateRange);
  const tier: 'daily' | 'hourly' = params.granularity === 'hourly' ? 'hourly' : 'daily';

  const available = await listLocalMonths(ctx.dataDir, tier);
  const required = computePeriodsInRange({ start: startStr, end: endStr });
  const periods = required.filter(p => available.includes(p));

  const dimensions = await getQueryDimensions();
  const accountMap = await getAccountMap();

  const tagColumns: readonly ExplorerTagColumn[] = dimensions.tags.map(t => ({
    id: tagColumnName(t.tagName),
    label: t.label,
  }));
  const tagIdSet = new Set(tagColumns.map(t => t.id));

  if (periods.length === 0) {
    return {
      empty: true,
      source: '',
      whereStr: '',
      startStr,
      endStr,
      windowDays,
      tier,
      tagColumns,
      tagIdSet,
      dimensions,
      accountMap,
    };
  }

  const orgPath = await getOrgAccountsPath();
  const availableColumns = await getAvailableColumns(tier);
  const applyCostScope = params.applyCostScope === true;
  const costScope = applyCostScope ? await getCostScope().catch(() => undefined) : undefined;
  const accountReverseMap = buildAccountReverseMap(accountMap);
  const metric = pickMetric(params.costMetric, availableColumns);
  const perspective = pickPerspective(params.costPerspective, availableColumns);

  const source = buildSource(
    ctx.dataDir,
    tier,
    dimensions,
    orgPath,
    periods,
    metric,
    availableColumns,
    perspective,
  );

  const filterPredicate = buildExplorerFilterPredicate(params.filters, dimensions, accountReverseMap);

  const exclusionClauses: string[] = [];
  if (costScope !== undefined) {
    for (const rule of costScope.rules) {
      if (!rule.enabled) continue;
      const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
      if (matchExpr === null) continue;
      exclusionClauses.push(`NOT (${matchExpr})`);
    }
  }

  const whereClauses: string[] = [
    `usage_date BETWEEN '${startStr}' AND '${endStr}'`,
    ...(filterPredicate === null ? [] : [`(${filterPredicate})`]),
    ...exclusionClauses,
  ];
  const whereStr = `WHERE ${whereClauses.join(' AND ')}`;

  return {
    empty: false,
    source,
    whereStr,
    startStr,
    endStr,
    windowDays,
    tier,
    tagColumns,
    tagIdSet,
    dimensions,
    accountMap,
  };
}

export function registerExplorerHandlers(app: AppContext): void {
  const { ctx, runQuery } = app;

  const explorerPrefsPath = () => prefsPath(ctx.dataDir, 'explorer-preferences');

  ipcMain.handle('explorer:get-preferences', async (): Promise<ExplorerPreferences> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await explorerPrefsPath(), 'utf-8');
      const obj = parseJsonObject(raw);
      const rawHidden = obj?.['hiddenColumns'];
      const rawOrder = obj?.['columnOrder'];
      const hiddenColumns = Array.isArray(rawHidden) && rawHidden.every((v): v is string => typeof v === 'string')
        ? rawHidden
        : [];
      const columnOrder = Array.isArray(rawOrder) && rawOrder.every((v): v is string => typeof v === 'string')
        ? rawOrder
        : [];
      return { hiddenColumns, columnOrder };
    } catch {
      // file doesn't exist yet — first-run defaults
    }
    return { hiddenColumns: [], columnOrder: [] };
  });

  ipcMain.handle('explorer:save-preferences', async (_event, prefs: ExplorerPreferences): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(await explorerPrefsPath(), JSON.stringify(prefs, null, 2));
  });

  // Histogram + totals. Depends on filters/range/granularity/scope/metric/
  // perspective — NOT on sort. Kept separate from the rows query so that
  // clicking a column header doesn't wipe the histogram.
  ipcMain.handle('explorer:query-overview', async (_event, payload: unknown): Promise<ExplorerOverviewResult> => {
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

    const totalsSql = `
      SELECT
        CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS total_cost,
        CAST(COUNT(*) AS DOUBLE) AS total_rows
      FROM ${qc.source}
      ${qc.whereStr}
    `.trim();

    // Bucket width matches the queried tier — daily rows group per day,
    // hourly rows group per hour. Without this the hourly-tier histogram
    // would collapse back to daily bars and hide the whole point of
    // switching granularity.
    const bucketExpr = qc.tier === 'hourly' ? 'usage_hour' : 'usage_date';
    const dailySql = `
      SELECT
        ${bucketExpr}::VARCHAR AS date,
        CAST(COALESCE(SUM(cost), 0) AS DOUBLE) AS daily_cost,
        CAST(COUNT(*) AS DOUBLE) AS daily_rows
      FROM ${qc.source}
      ${qc.whereStr}
      GROUP BY ${bucketExpr}
      ORDER BY ${bucketExpr}
    `.trim();

    const [totalsResult, dailyResult] = await Promise.allSettled([
      runQuery(totalsSql),
      runQuery(dailySql),
    ]);

    let totalCost = 0;
    let totalRows = 0;
    if (totalsResult.status === 'fulfilled') {
      const row = totalsResult.value[0];
      totalCost = toNum(row?.['total_cost']);
      totalRows = toNum(row?.['total_rows']);
    } else {
      logger.warn(`explorer: totals query failed: ${totalsResult.reason instanceof Error ? totalsResult.reason.message : String(totalsResult.reason)}`);
    }

    let dailyTotals: readonly ExplorerDailyRow[] = [];
    if (dailyResult.status === 'fulfilled') {
      dailyTotals = dailyResult.value.map(r => {
        const raw = r['date'];
        const date = typeof raw === 'string' ? raw : raw instanceof Date ? raw.toISOString().slice(0, 10) : '';
        return { date, cost: toNum(r['daily_cost']), rows: toNum(r['daily_rows']) };
      });
    } else {
      logger.warn(`explorer: daily query failed: ${dailyResult.reason instanceof Error ? dailyResult.reason.message : String(dailyResult.reason)}`);
    }

    return {
      windowDays: qc.windowDays,
      startDate: qc.startStr,
      endDate: qc.endStr,
      dailyTotals,
      totalRows,
      totalCost,
      tagColumns: qc.tagColumns,
    };
  });

  // Sample rows. Depends on everything the overview does PLUS sort + rowLimit.
  ipcMain.handle('explorer:query-rows', async (_event, payload: unknown): Promise<ExplorerRowsResult> => {
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
        account_id, account_name, region, service, service_family,
        line_item_type, operation, usage_type, description, resource_id,
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
          serviceFamily: toStr(r['service_family']),
          lineItemType: toStr(r['line_item_type']),
          operation: toStr(r['operation']),
          usageType: toStr(r['usage_type']),
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
  });

  ipcMain.handle('explorer:query-aggregated-table', async (_event, payload: unknown): Promise<AggregatedTableResult> => {
    const params = payload as AggregatedTableParams;
    const qc = await prepareQueryContext(app, params);
    const rowLimit = clampRowLimit(params.rowLimit);

    if (qc.empty) return { rows: [], totalRows: 0, tagColumns: qc.tagColumns };

    let whereStr = qc.whereStr;
    if (params.rowFilters !== undefined) {
      const extra: string[] = [];
      for (const [col, val] of Object.entries(params.rowFilters)) {
        if (val.length === 0) continue;
        if (!SORTABLE_SCALAR_COLUMNS.has(col) && !qc.tagIdSet.has(col)) continue;
        const escaped = val.replace(/'/g, "''");
        const colExpr = col === 'usage_date' ? `usage_date::VARCHAR` : col;
        extra.push(`${colExpr} = '${escaped}'`);
      }
      if (extra.length > 0) {
        whereStr = `${whereStr} AND ${extra.join(' AND ')}`;
      }
    }

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
    const orderBy = (() => {
      if (params.sort === undefined) return 'SUM(cost) DESC';
      const dir = params.sort.direction === 'asc' ? 'ASC' : 'DESC';
      const col = params.sort.column;
      if (col === 'cost') return `SUM(cost) ${dir}`;
      if (col === 'list_cost') return `SUM(list_cost) ${dir}`;
      if (col === 'usage_amount') return `SUM(usage_amount) ${dir}`;
      if (col === 'row_count') return `COUNT(*) ${dir}`;
      if (groupByColumns.includes(col)) return `${col} ${dir}`;
      return 'SUM(cost) DESC';
    })();

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
    const totalRows = countResult[0] !== undefined ? toNum(countResult[0]['n']) : 0;
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
  });

  ipcMain.handle('explorer:filter-values', async (_event, payload: unknown): Promise<ExplorerFilterValue[]> => {
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

    const builtIn = qc.dimensions.builtIn.find(d => d.name === dimId);
    const tag = qc.dimensions.tags.find(d => tagColumnName(d.tagName) === dimId);
    const field = builtIn === undefined ? dimId : builtIn.field;
    let fieldExpr = field;
    if (builtIn !== undefined) fieldExpr = buildAliasSqlCase(field, builtIn);
    else if (tag !== undefined) fieldExpr = buildAliasSqlCase(tagColumnName(tag.tagName), tag);

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
  });
}
