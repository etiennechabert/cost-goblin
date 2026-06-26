import type { BuiltInDimension, DimensionsConfig, TagDimension } from '../types/config.js';
import type { CostQueryParams, DailyCostsParams, FilterMap, TrendQueryParams, MissingTagsParams, EntityDetailParams } from '../types/query.js';
import { DEFAULT_PLACEHOLDER_PATTERNS } from '../types/query.js';
import type { DimensionId } from '../types/branded.js';
import { tagDimColumn } from '../types/branded.js';
import { OU_PATH_SOURCE_KEY } from '../types/config.js';
import type { CostMetric, CostPerspective, CostScopeConfig, ExclusionRule, MarketplaceAttributionConfig, MarketplaceAttributionRule } from '../types/cost-scope.js';
import { buildAliasSqlCase, normalizeTagValue, resolveAlias } from '../normalize/normalize.js';
import { costExprFor, LIST_METRIC_LINE_ITEM_TYPES } from './cost-metric.js';
import { QueryBuilder, type ParameterizedQuery } from './parameterized.js';
import { assertDateString, assertHourString, SecurityError } from './identifier-validator.js';
import { rollupGrainColumns, rollupGrainDimensions } from '../rollup/grain.js';

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Query parameter "${name}" must be a non-negative finite number, got ${String(value)}`);
  }
}

function sqlEscapeString(value: string): string {
  return value.replaceAll("'", "''");
}

/** Build a SQL IN-list. Uses placeholders when a QueryBuilder is provided;
 *  otherwise falls back to escaped string literals (for exported helpers
 *  like `buildRuleMatchExpr` that may be called without a QueryBuilder). */
function buildSqlList(values: readonly string[], qb?: QueryBuilder): string {
  if (qb !== undefined) {
    return values.map(v => qb.addParam(v)).join(', ');
  }
  return values.map(v => `'${sqlEscapeString(v)}'`).join(', ');
}

/**
 * YYYY-MM month strings that a date range touches, inclusive. The data layout
 * is one directory per billing period (e.g. `daily-2026-03/`), so a 30-day
 * window ending 2026-04-18 only needs 2026-03 and 2026-04 — skipping the other
 * 11+ months of data avoids the Parquet footer reads for those files and is
 * the biggest single perf win for short-window queries over a year of data.
 *
 * Inputs are YYYY-MM-DD strings (as produced by asDateString). Output is sorted
 * ascending and de-duplicated.
 */
export function computePeriodsInRange(dateRange: { readonly start: string; readonly end: string }): string[] {
  const start = new Date(`${dateRange.start}T00:00:00Z`);
  const end = new Date(`${dateRange.end}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const periods: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    periods.push(`${String(y)}-${String(m).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return periods;
}

interface ResolvedDimension {
  readonly fieldExpr: string;
  readonly rawField: string;
  /** The backing dim, when the id resolves to a known built-in or tag.
   *  Carries `normalize` and `aliases` so callers that compare literal
   *  values against the CASE-wrapped field expression can apply the
   *  same transformation to their values and stay in agreement. */
  readonly dim: BuiltInDimension | TagDimension | null;
}

function tryResolveField(dimensionId: DimensionId, dimensions: DimensionsConfig): ResolvedDimension | null {
  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  if (builtIn !== undefined) {
    // Built-ins now support normalize + aliases just like tags; apply them at
    // query time via the same CASE/LOWER(...) machinery.
    const fieldExpr = buildAliasSqlCase(builtIn.field, builtIn);
    return { fieldExpr, rawField: builtIn.field, dim: builtIn };
  }

  const tag = dimensions.tags.find(d => tagDimColumn(d) === dimensionId);
  if (tag !== undefined) {
    const rawField = tagDimColumn(tag);
    return { fieldExpr: buildAliasSqlCase(rawField, tag), rawField, dim: tag };
  }

  return null;
}

/** Apply the same normalize + alias transformation that `buildAliasSqlCase`
 *  bakes into the field expression, but to a literal value on the JS side.
 *  Required when the SQL compares a normalized/alias-resolved column
 *  against hard-coded values like the built-in rules' service codes — the
 *  values need to be moved into the same namespace as the column output or
 *  the match will silently miss. */
function normalizeRuleValue(value: string, dim: BuiltInDimension | TagDimension | null): string {
  if (dim === null) return value;
  const normalized = normalizeTagValue(value, dim.normalize);
  return resolveAlias(normalized, dim.aliases);
}

function resolveField(dimensionId: DimensionId, dimensions: DimensionsConfig): ResolvedDimension {
  const resolved = tryResolveField(dimensionId, dimensions);
  if (resolved !== null) return resolved;
  throw new SecurityError(
    `Unknown dimension "${dimensionId}" — not found in dimensions config. ` +
    `This prevents SQL injection via untrusted identifiers.`
  );
}

function buildSingleFilterClause(
  resolved: ResolvedDimension,
  values: readonly string[],
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  qb: QueryBuilder,
): string {
  const expanded = tryExpandAccountIds(values, resolved.rawField, accountReverseMap, qb);
  if (expanded !== null) return expanded;

  const first = values[0];
  if (values.length === 1 && first !== undefined) {
    const placeholder = qb.addParam(first);
    return `${resolved.fieldExpr} = ${placeholder}`;
  }
  const list = buildSqlList(values, qb);
  return `${resolved.fieldExpr} IN (${list})`;
}

function buildFilterClauses(
  filters: FilterMap,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  qb: QueryBuilder,
): string[] {
  const clauses: string[] = [];
  for (const [dimId, values] of Object.entries(filters)) {
    if (values === undefined || values.length === 0) continue;
    const resolved = resolveField(dimId as DimensionId, dimensions);
    clauses.push(buildSingleFilterClause(resolved, values, accountReverseMap, qb));
  }
  return clauses;
}

/** Try to expand account display-names back to raw IDs via the reverse map.
 *  Returns the SQL fragment if expansion was used, or null to fall through. */
function tryExpandAccountIds(
  values: readonly string[],
  rawField: string,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  qb: QueryBuilder | undefined,
): string | null {
  if (rawField !== 'account_id' || accountReverseMap === undefined) return null;
  const expandedIds = new Set<string>();
  let usedReverse = false;
  for (const v of values) {
    const ids = accountReverseMap.get(v);
    if (ids !== undefined && ids.length > 0) {
      for (const id of ids) expandedIds.add(id);
      usedReverse = true;
    } else {
      expandedIds.add(v);
    }
  }
  if (!usedReverse) return null;
  const list = buildSqlList([...expandedIds], qb);
  return `${rawField} IN (${list})`;
}

/** Build the SQL fragment for a single condition within a rule. Returns null
 *  when the condition should be skipped (empty values, unknown dimension). */
function buildConditionSql(
  cond: ExclusionRule['conditions'][number],
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  qb: QueryBuilder | undefined,
): string | null {
  if (cond.values.length === 0) return null;
  const resolved = tryResolveField(cond.dimensionId, dimensions);
  if (resolved === null) return null;
  const expanded = tryExpandAccountIds(cond.values, resolved.rawField, accountReverseMap, qb);
  if (expanded !== null) return expanded;
  const normalizedValues = cond.values.map(v => normalizeRuleValue(v, resolved.dim));
  const list = buildSqlList(normalizedValues, qb);
  return `${resolved.fieldExpr} IN (${list})`;
}

/** Build the positive match expression for a single rule (AND of conditions,
 *  OR within each condition's values). Used both for NOT-exclusion in queries
 *  and for the positive preview queries. Returns null when the rule has no
 *  valid conditions (all empty values). */
export function buildRuleMatchExpr(
  rule: ExclusionRule,
  dimensions: DimensionsConfig,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  qb?: QueryBuilder,
): string | null {
  const conditionSqls: string[] = [];
  for (const cond of rule.conditions) {
    const sql = buildConditionSql(cond, dimensions, accountReverseMap, qb);
    if (sql !== null) conditionSqls.push(sql);
  }
  if (conditionSqls.length === 0) return null;
  return conditionSqls.join(' AND ');
}

/** Try to merge a single-condition rule into the merged map. Returns true if
 *  it was merged (or skipped as invalid); false if it should fall through to
 *  multi-condition handling. */
function tryMergeSingleConditionRule(
  rule: ExclusionRule,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  merged: Map<string, { resolved: ResolvedDimension; values: string[] }>,
): boolean {
  if (rule.conditions.length !== 1) return false;
  const cond = rule.conditions[0];
  if (cond === undefined || cond.values.length === 0) return true;
  const resolved = tryResolveField(cond.dimensionId, dimensions);
  if (resolved === null) return true;
  if (resolved.rawField === 'account_id' && accountReverseMap !== undefined) return false;
  const normalizedValues = cond.values.map(v => normalizeRuleValue(v, resolved.dim));
  const existing = merged.get(cond.dimensionId);
  if (existing === undefined) {
    merged.set(cond.dimensionId, { resolved, values: [...normalizedValues] });
  } else {
    existing.values.push(...normalizedValues);
  }
  return true;
}

function buildExclusionClauses(
  rules: readonly ExclusionRule[],
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  qb: QueryBuilder,
): string[] {
  const singleConditionByDim = new Map<string, { resolved: ResolvedDimension; values: string[] }>();
  const multiConditionRules: ExclusionRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!tryMergeSingleConditionRule(rule, dimensions, accountReverseMap, singleConditionByDim)) {
      multiConditionRules.push(rule);
    }
  }

  const clauses: string[] = [];

  for (const [, { resolved, values }] of singleConditionByDim) {
    const list = buildSqlList(values, qb);
    clauses.push(`${resolved.fieldExpr} NOT IN (${list})`);
  }

  for (const rule of multiConditionRules) {
    const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap, qb);
    if (matchExpr === null) continue;
    clauses.push(`NOT (${matchExpr})`);
  }

  return clauses;
}

/**
 * Build the Parquet source subquery. Two modes:
 *   1. narrowed wildcard (periods provided): read_parquet on explicit month
 *      directories. Cuts Parquet footer reads for short-window queries.
 *   2. full wildcard (no periods): daily-*\/*.parquet. Original path.
 *
 * DuckDB errors when any glob in the list matches zero files — so callers
 * must pre-filter `periods` to months that actually exist on disk.
 */
function buildTagSelect(
  t: DimensionsConfig['tags'][number],
  needsOrgJoin: boolean,
): string {
  const colName = tagDimColumn(t);
  const valueExpr = buildTagValueExpr(t, needsOrgJoin, colName);
  const wrapped = applyPathSegment(valueExpr, t.pathSegment);
  return `${wrapped} AS ${colName}`;
}

function buildTagValueExpr(
  t: DimensionsConfig['tags'][number],
  needsOrgJoin: boolean,
  colName: string,
): string {
  const hasResourceTag = t.tagName !== undefined && t.tagName.length > 0;
  const hasFallback = t.accountTagFallback !== undefined;

  // Account-source-only dimension: emit just the fallback column.
  if (!hasResourceTag) {
    if (needsOrgJoin && hasFallback) return `acct_tags.fallback_${colName}`;
    return 'NULL';
  }

  const tagName = t.tagName ?? '';
  const rawKey = tagName.startsWith('user_') ? tagName : `user_${tagName}`;
  const curKey = sqlEscapeString(rawKey);
  const tablePrefix = needsOrgJoin ? 'cur.' : '';
  const resourceExpr = `element_at(${tablePrefix}resource_tags, '${curKey}')[1]`;

  if (!hasFallback || !needsOrgJoin) return resourceExpr;

  const fallbackExpr = `acct_tags.fallback_${colName}`;
  if (t.missingValueTemplate !== undefined && t.missingValueTemplate.length > 0 && t.missingValueTemplate !== '{fallback}') {
    const parts = t.missingValueTemplate.split('{fallback}');
    const prefix = sqlEscapeString(parts[0] ?? '');
    const suffix = sqlEscapeString(parts[1] ?? '');
    const formatted = `'${prefix}' || ${fallbackExpr} || '${suffix}'`;
    return `COALESCE(NULLIF(${resourceExpr}, ''), ${formatted})`;
  }
  return `COALESCE(NULLIF(${resourceExpr}, ''), ${fallbackExpr})`;
}

function applyPathSegment(expr: string, pathSegment: { separator: string; index: number } | undefined): string {
  if (pathSegment === undefined) return expr;
  const sep = sqlEscapeString(pathSegment.separator);
  // DuckDB's split_part is 1-based and supports negative indices (-1 = last).
  // NULLIF guards against returning the empty string when the segment index
  // is out of range (split_part returns '' rather than NULL in that case).
  return `NULLIF(split_part(${expr}, '${sep}', ${String(pathSegment.index)}), '')`;
}

export interface BuildSourceOptions {
  readonly dataDir: string;
  readonly tier: string;
  readonly dimensions: DimensionsConfig;
  readonly orgAccountsPath?: string | undefined;
  readonly periods?: readonly string[] | undefined;
  readonly costMetric?: CostMetric | undefined;
  readonly availableColumns?: ReadonlySet<string> | undefined;
  readonly costPerspective?: CostPerspective | undefined;
  /** When true, tags with accountTagFallback also emit a raw_<col> column
   *  containing the resource-level value before COALESCE fallback. Used by
   *  the missing-tags query to detect truly untagged resources. */
  readonly includeRawTags?: boolean | undefined;
  /** When true, omits columns only needed by Explorer/aggregated-table:
   *  description, usage_amount, list_cost. Used by the materialized base
   *  to keep the in-memory table small. */
  readonly slim?: boolean | undefined;
  /** Re-attributes empty-product_servicecode AWS Marketplace rows to a real
   *  service (and, on the `list` metric, swaps the $0 list price for unblended
   *  cost). Omitted/disabled → raw CUR attribution. */
  readonly marketplaceAttribution?: MarketplaceAttributionConfig | undefined;
}

/** Active marketplace rules: only when enabled, dropping malformed entries. */
function activeMarketplaceRules(
  cfg: MarketplaceAttributionConfig | undefined,
): readonly MarketplaceAttributionRule[] {
  if (cfg === undefined || !cfg.enabled) return [];
  return cfg.rules.filter(r => r.service.length > 0 && r.operations.length > 0);
}

/** SQL predicate matching any active rule's Marketplace rows (empty
 *  product_servicecode + matching operation). Null when nothing is active. */
function marketplaceMatchPredicate(
  prefix: string,
  rules: readonly MarketplaceAttributionRule[],
): string | null {
  if (rules.length === 0) return null;
  const ops = [...new Set(rules.flatMap(r => r.operations))]
    .map(o => `'${sqlEscapeString(o)}'`)
    .join(', ');
  return `COALESCE(${prefix}product_servicecode, '') = '' AND ${prefix}line_item_operation IN (${ops})`;
}

/** Wraps the base service expression in a CASE that rewrites each rule's
 *  empty-servicecode Marketplace rows to its target service code. */
function marketplaceServiceExpr(
  prefix: string,
  base: string,
  rules: readonly MarketplaceAttributionRule[],
): string {
  if (rules.length === 0) return base;
  const branches = rules.map(r => {
    const ops = r.operations.map(o => `'${sqlEscapeString(o)}'`).join(', ');
    return `WHEN COALESCE(${prefix}product_servicecode, '') = '' AND ${prefix}line_item_operation IN (${ops}) THEN '${sqlEscapeString(r.service)}'`;
  });
  return `CASE ${branches.join(' ')} ELSE ${base} END`;
}

/** Marketplace rows have a $0 public-on-demand price, so any expression keyed
 *  on it (the `list` metric, the `list_cost` column) reports them as free.
 *  Substitute unblended cost — the only real figure AWS gives these rows —
 *  for matched rows. No-op when the predicate is null. */
function marketplaceListFallback(prefix: string, base: string, matchPredicate: string | null): string {
  if (matchPredicate === null) return base;
  return `CASE WHEN ${matchPredicate} THEN COALESCE(${prefix}line_item_unblended_cost, 0) ELSE ${base} END`;
}

function buildRawTagSelects(dimensions: DimensionsConfig): string[] {
  const selects: string[] = [];
  for (const t of dimensions.tags) {
    if (t.accountTagFallback === undefined) continue;
    if (t.tagName === undefined || t.tagName.length === 0) continue;
    const rawKey = t.tagName.startsWith('user_') ? t.tagName : `user_${t.tagName}`;
    const curKey = sqlEscapeString(rawKey);
    const colName = tagDimColumn(t);
    selects.push(`element_at(cur.resource_tags, '${curKey}')[1] AS raw_${colName}`);
  }
  return selects;
}

function buildParquetSource(dataDir: string, tier: string, periods: readonly string[] | undefined): string {
  // union_by_name unifies columns by name across files, filling absent columns
  // with NULL. Required because CUR schema drifts between months: older exports
  // lack reservation_effective_cost / savings_plan_savings_plan_effective_cost
  // while newer ones carry them. getAvailableColumns probes only the latest
  // month, so the amortized expression references those columns; without
  // union_by_name DuckDB throws a Binder Error on any read spanning a month
  // that omits them. The now-NULL column makes amortizedExpr's COALESCE fall
  // through to unblended for the old rows — the correct degradation.
  if (periods !== undefined && periods.length > 0) {
    const paths = periods.map(p => `'${dataDir}/aws/raw/${tier}-${p}/*.parquet'`).join(', ');
    return `read_parquet([${paths}], union_by_name=true)`;
  }
  return `read_parquet('${dataDir}/aws/raw/${tier}-*/*.parquet', union_by_name=true)`;
}

function buildFromClause(
  parquetSource: string,
  dimensions: DimensionsConfig,
  orgAccountsPath: string,
): string {
  const fallbackSelects = dimensions.tags
    .filter(t => t.accountTagFallback !== undefined)
    .map(t => {
      const colName = tagDimColumn(t);
      const fallback = t.accountTagFallback ?? '';
      if (fallback === OU_PATH_SOURCE_KEY) {
        return `ouPath AS fallback_${colName}`;
      }
      const fallbackKey = sqlEscapeString(fallback);
      return `tags->>'${fallbackKey}' AS fallback_${colName}`;
    });
  return `${parquetSource} AS cur
      LEFT JOIN (
        SELECT id, ${fallbackSelects.join(', ')}
        FROM read_json_auto('${orgAccountsPath}')
      ) AS acct_tags ON cur.line_item_usage_account_id = acct_tags.id`;
}

export function buildSource(opts: BuildSourceOptions): string {
  const { dataDir, tier, dimensions, orgAccountsPath, periods, costMetric = 'unblended', availableColumns, costPerspective, includeRawTags, slim } = opts;
  const hasFallbacks = dimensions.tags.some(t => t.accountTagFallback !== undefined);
  const needsOrgJoin = hasFallbacks && orgAccountsPath !== undefined;

  const tagSelects = dimensions.tags.map(t => buildTagSelect(t, needsOrgJoin));
  if (includeRawTags === true && needsOrgJoin) {
    tagSelects.push(...buildRawTagSelects(dimensions));
  }
  const tagClause = tagSelects.length > 0 ? `,\n      ${tagSelects.join(',\n      ')}` : '';

  const dateExpr = tier === 'hourly'
    ? 'line_item_usage_start_date::DATE AS usage_date,\n      line_item_usage_start_date::TIMESTAMP AS usage_hour'
    : 'line_item_usage_start_date::DATE AS usage_date';

  const parquetSource = buildParquetSource(dataDir, tier, periods);
  const fromClause = hasFallbacks && orgAccountsPath !== undefined
    ? buildFromClause(parquetSource, dimensions, orgAccountsPath)
    : parquetSource;
  const tablePrefix = needsOrgJoin ? 'cur.' : '';

  // Marketplace re-attribution: matched rows get a real service code, and on
  // the `list` metric their $0 public-on-demand price is replaced with
  // unblended cost (see marketplaceListFallback).
  const mktRules = activeMarketplaceRules(opts.marketplaceAttribution);
  const mktMatch = marketplaceMatchPredicate(tablePrefix, mktRules);

  const baseCostExpr = costExprFor(costMetric, tablePrefix, costPerspective, availableColumns);
  const costExpr = costMetric === 'list'
    ? marketplaceListFallback(tablePrefix, baseCostExpr, mktMatch)
    : baseCostExpr;

  const serviceExpr = marketplaceServiceExpr(
    tablePrefix,
    `COALESCE(${tablePrefix}product_servicecode, '')`,
    mktRules,
  );

  const listCostExpr = marketplaceListFallback(
    tablePrefix,
    `COALESCE(${tablePrefix}pricing_public_on_demand_cost, 0)`,
    mktMatch,
  );
  const flexColumns = slim === true ? '' : `
      COALESCE(${tablePrefix}line_item_line_item_description, '') AS description,
      COALESCE(${tablePrefix}line_item_usage_amount, 0) AS usage_amount,
      ${listCostExpr} AS list_cost,`;

  // The `list` metric reports on-demand list price for usage that actually
  // happened. RI/SP fee rows (RIFee, SavingsPlanRecurringFee, etc.) have no
  // retail equivalent, and including them just adds zero-cost rows that bloat
  // group-by buckets. Restrict at the source level so every downstream query
  // (Explorer, custom views, MCP, materialized base) sees a consistent slice.
  const metricWhere = costMetric === 'list'
    ? `\n    WHERE COALESCE(${tablePrefix}line_item_line_item_type, '') IN (${LIST_METRIC_LINE_ITEM_TYPES.map(t => `'${t}'`).join(', ')})`
    : '';

  return `(
    SELECT
      ${dateExpr},
      ${tablePrefix}line_item_usage_account_id AS account_id,
      COALESCE(${tablePrefix}line_item_usage_account_name, '') AS account_name,
      COALESCE(${tablePrefix}product_region_code, '') AS region,
      ${serviceExpr} AS service,
      COALESCE(${tablePrefix}product_product_family, '') AS service_family,${flexColumns}
      COALESCE(${tablePrefix}line_item_resource_id, '') AS resource_id,
      ${costExpr} AS cost,
      COALESCE(${tablePrefix}line_item_line_item_type, '') AS line_item_type,
      COALESCE(${tablePrefix}line_item_operation, '') AS operation,
      COALESCE(${tablePrefix}line_item_usage_type, '') AS usage_type${tagClause}
    FROM ${fromClause}${metricWhere}
  )`;
}

/**
 * Compute the Parquet glob periods for a query. Intersects the months the
 * query's date range touches with the months actually on disk — DuckDB errors
 * on glob patterns that match zero files, so the caller must pre-filter. When
 * `availablePeriods` is omitted (tests, filter-values without date range),
 * falls back to all required periods. An empty result means "use the wildcard".
 */
function resolveQueryPeriods(
  dateRange: { readonly start: string; readonly end: string },
  availablePeriods?: readonly string[],
): string[] {
  const required = computePeriodsInRange(dateRange);
  if (availablePeriods === undefined) return required;
  return required.filter(p => availablePeriods.includes(p));
}

interface DateRangeLike {
  readonly start: string;
  readonly end: string;
  readonly startHour?: string | undefined;
  readonly endHour?: string | undefined;
}

/** True when the range has both hour bounds set. Hour bounds are an additive
 *  refinement on top of the day-level start/end; they only kick in for
 *  hourly-tier queries (the daily Parquet files don't have usage_hour). */
function hasHourBounds(dateRange: DateRangeLike): boolean {
  return dateRange.startHour !== undefined && dateRange.endHour !== undefined;
}

/** When hour bounds are present, the query must read from the hourly tier so
 *  that usage_hour is available to filter on. Promote the requested tier
 *  accordingly. */
function effectiveTier(requestedTier: string, dateRange: DateRangeLike): string {
  return hasHourBounds(dateRange) ? 'hourly' : requestedTier;
}

/** WHERE expression for the date range. With hour bounds set we filter at the
 *  hour level (inclusive on both ends) — `usage_hour BETWEEN startHour AND endHour`.
 *  Without them we keep the cheaper day-level filter. Both forms use parameter
 *  placeholders so untrusted values stay out of the SQL string. */
function buildDateRangeWhere(qb: QueryBuilder, dateRange: DateRangeLike): string {
  if (dateRange.startHour !== undefined && dateRange.endHour !== undefined) {
    assertHourString(dateRange.startHour);
    assertHourString(dateRange.endHour);
    const sh = qb.addParam(dateRange.startHour);
    const eh = qb.addParam(dateRange.endHour);
    return `usage_hour BETWEEN ${sh}::TIMESTAMP AND ${eh}::TIMESTAMP`;
  }
  const s = qb.addParam(dateRange.start);
  const e = qb.addParam(dateRange.end);
  return `usage_date BETWEEN ${s} AND ${e}`;
}

interface CommonQueryArgs {
  readonly filters: FilterMap;
  readonly dateRange: DateRangeLike;
}

interface CommonQuerySetup {
  readonly qb: QueryBuilder;
  readonly filterClauses: string[];
  readonly exclusionClauses: string[];
  readonly source: string;
  readonly costMetric: CostMetric;
}

export interface QueryContextOptions {
  readonly dataDir: string;
  readonly dimensions: DimensionsConfig;
  readonly orgAccountsPath?: string | undefined;
  readonly availablePeriods?: readonly string[] | undefined;
  readonly accountReverseMap?: ReadonlyMap<string, readonly string[]> | undefined;
  readonly costScope?: CostScopeConfig | undefined;
  readonly availableColumns?: ReadonlySet<string> | undefined;
  readonly materializedSource?: string | undefined;
}

function setupQuery(
  params: CommonQueryArgs,
  tier: string,
  opts: QueryContextOptions,
  extraSourceOpts?: Partial<BuildSourceOptions>,
): CommonQuerySetup {
  const { dataDir, dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns, materializedSource } = opts;
  const qb = new QueryBuilder();
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap, qb);
  const costMetric = costScope?.costMetric ?? 'unblended';

  // The materialized base table is built at daily tier and lacks usage_hour,
  // so it can't satisfy hour-bounded queries. Fall through to a fresh hourly
  // Parquet read in that case.
  if (materializedSource !== undefined && !hasHourBounds(params.dateRange)) {
    return { qb, filterClauses, exclusionClauses: [], source: materializedSource, costMetric };
  }

  const exclusionClauses = costScope === undefined ? [] : buildExclusionClauses(costScope.rules, dimensions, accountReverseMap, qb);
  const costPerspective = costScope?.costPerspective ?? 'gross';
  const periods = resolveQueryPeriods(params.dateRange, availablePeriods);
  const resolvedTier = effectiveTier(tier, params.dateRange);
  const source = buildSource({ dataDir, tier: resolvedTier, dimensions, orgAccountsPath, periods, costMetric, availableColumns, costPerspective, marketplaceAttribution: costScope?.marketplaceAttribution, ...extraSourceOpts });
  return { qb, filterClauses, exclusionClauses, source, costMetric };
}

export function buildCostQuery(
  params: CostQueryParams,
  opts: QueryContextOptions,
  topN: number = 5,
): ParameterizedQuery {
  assertFiniteNumber(topN, 'topN');
  const costTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, costTier, opts);
  const groupByResolved = resolveField(params.groupBy, opts.dimensions);

  const whereConditions = [
    buildDateRangeWhere(qb, params.dateRange),
    ...filterClauses,
    ...exclusionClauses,
  ];

  if (params.orgNodeValues !== undefined && params.orgNodeValues.length > 0) {
    const placeholders = params.orgNodeValues.map(v => qb.addParam(v)).join(', ');
    whereConditions.push(`${groupByResolved.fieldExpr} IN (${placeholders})`);
  }

  const topNPlaceholder = qb.addParam(topN);

  const sql = `
    WITH base AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        service,
        SUM(cost) AS cost
      FROM ${source}
      WHERE ${whereConditions.join(' AND ')}
      GROUP BY entity, service
    ),
    top_services AS (
      SELECT service
      FROM base
      GROUP BY service
      ORDER BY SUM(cost) DESC
      LIMIT ${topNPlaceholder}
    ),
    entity_totals AS (
      SELECT
        entity,
        SUM(cost) AS total_cost
      FROM base
      GROUP BY entity
    )
    SELECT
      et.entity,
      et.total_cost,
      b.service,
      COALESCE(b.cost, 0) AS service_cost
    FROM entity_totals et
    LEFT JOIN base b ON et.entity = b.entity AND b.service IN (SELECT service FROM top_services)
    ORDER BY et.total_cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

export function buildTrendQuery(
  params: TrendQueryParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  const { dataDir, dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns, materializedSource } = opts;
  assertFiniteNumber(Number(params.deltaThreshold), 'deltaThreshold');
  const qb = new QueryBuilder();
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap, qb);
  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';

  const startDate = params.dateRange.start;
  const endDate = params.dateRange.end;

  let source: string;
  let exclusionClauses: string[];
  if (materializedSource === undefined) {
    exclusionClauses = costScope === undefined ? [] : buildExclusionClauses(costScope.rules, dimensions, accountReverseMap, qb);

    // Trend reads both the current period and the previous (same-duration)
    // period, so the source needs to cover months from both spans. The previous
    // span ends the day before `startDate`.
    const currentPeriods = computePeriodsInRange(params.dateRange);
    const dayMs = 24 * 60 * 60 * 1000;
    const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
    const endMs = new Date(`${endDate}T00:00:00Z`).getTime();
    const durationDays = Math.round((endMs - startMs) / dayMs) + 1;
    const prevEndIso = new Date(startMs - dayMs).toISOString().slice(0, 10);
    const prevStartIso = new Date(startMs - durationDays * dayMs).toISOString().slice(0, 10);
    const previousPeriods = computePeriodsInRange({ start: prevStartIso, end: prevEndIso });
    const required = [...new Set([...currentPeriods, ...previousPeriods])].sort((a, b) => a.localeCompare(b));
    const periods = availablePeriods === undefined ? required : required.filter(p => availablePeriods.includes(p));
    source = buildSource({ dataDir, tier: 'daily', dimensions, orgAccountsPath, periods, costMetric, availableColumns, costPerspective, marketplaceAttribution: costScope?.marketplaceAttribution });
  } else {
    source = materializedSource;
    exclusionClauses = [];
  }

  const allFilterClauses = [...filterClauses, ...exclusionClauses];
  const filterWhere = allFilterClauses.length > 0 ? ` AND ${allFilterClauses.join(' AND ')}` : '';

  const startDatePlaceholder = qb.addParam(startDate);
  const endDatePlaceholder = qb.addParam(endDate);
  const deltaThresholdPlaceholder = qb.addParam(Number(params.deltaThreshold));

  // Single-scan approach: read the combined date range once and bucket rows
  // into current/previous via a CASE expression, avoiding scanning the
  // source twice.
  const sql = `
    WITH bucketed AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        CASE
          WHEN usage_date BETWEEN ${startDatePlaceholder} AND ${endDatePlaceholder} THEN 'current'
          ELSE 'previous'
        END AS period,
        cost
      FROM ${source}
      WHERE usage_date BETWEEN
        CAST(${startDatePlaceholder} AS DATE) - (DATEDIFF('day', CAST(${startDatePlaceholder} AS DATE), CAST(${endDatePlaceholder} AS DATE)) + 1) * INTERVAL '1 day'
        AND ${endDatePlaceholder}${filterWhere}
    ),
    agg AS (
      SELECT
        entity,
        SUM(CASE WHEN period = 'current' THEN cost ELSE 0 END) AS current_cost,
        SUM(CASE WHEN period = 'previous' THEN cost ELSE 0 END) AS previous_cost
      FROM bucketed
      GROUP BY entity
    )
    SELECT
      entity,
      current_cost,
      previous_cost,
      current_cost - previous_cost AS delta,
      CASE
        WHEN previous_cost = 0 THEN NULL
        ELSE (current_cost - previous_cost) / previous_cost * 100
      END AS percent_change
    FROM agg
    WHERE ABS(current_cost - previous_cost) >= ${deltaThresholdPlaceholder}
    ORDER BY ABS(current_cost - previous_cost) DESC
  `.trim();

  return { sql, params: qb.build().params };
}

/**
 * Missing-tags classifier.
 *
 * Pass 1 (resources CTE): aggregate Usage/DiscountedUsage line items by
 * resource_id. A resource is "tagged" if ANY of its line items in the window
 * has the target tag populated — tags can be added mid-month.
 *
 * Pass 2 (category_coverage CTE): per (service, service_family), compute the
 * cost-weighted ratio of cost that is tagged. A category with ratio = 0 is
 * "likely-untaggable": no resource in it has ever been tagged, so either AWS
 * doesn't allow it or the org never has. A category with ratio > 0 has proof
 * that it IS taggable, so untagged resources in it are "actionable".
 *
 * Returns one row per untagged resource with its category's tagged ratio and
 * bucket. The minCost threshold filters per-resource, after classification —
 * so a small untaggable resource is hidden the same way a small actionable
 * one is.
 */
export function buildMissingTagsQuery(
  params: MissingTagsParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  assertFiniteNumber(Number(params.minCost), 'minCost');
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, 'daily', opts, { includeRawTags: true });
  const tagResolved = resolveField(params.tagDimension, opts.dimensions);

  // Use the raw_ column (before COALESCE fallback) when available, so that
  // resources with only an account-level fallback are still reported as untagged.
  const tagDim = tagResolved.dim !== null && !('field' in tagResolved.dim) ? tagResolved.dim : undefined;
  const hasRawColumn = tagDim?.accountTagFallback !== undefined && tagDim.tagName !== undefined && tagDim.tagName.length > 0 && opts.orgAccountsPath !== undefined;
  const tagCheckField = hasRawColumn ? `raw_${tagResolved.rawField}` : tagResolved.rawField;

  const whereConditions = [
    buildDateRangeWhere(qb, params.dateRange),
    `line_item_type IN ('Usage', 'DiscountedUsage')`,
    `resource_id IS NOT NULL AND resource_id != ''`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  // Treat placeholder values (e.g. `unknown-cyber-security`, `none`, `n/a`)
  // as missing in addition to NULL and empty string. Without this, tagging
  // pipelines that backfill a placeholder to satisfy "non-empty" downstream
  // constraints would be counted as tagged and the gap would be understated.
  const placeholderPatterns = params.placeholderPatterns ?? DEFAULT_PLACEHOLDER_PATTERNS;
  const placeholderClauses = placeholderPatterns.map(pattern => {
    const placeholder = qb.addParam(pattern);
    return `${tagCheckField} NOT ILIKE ${placeholder}`;
  });
  const isTaggedExpr = [
    `${tagCheckField} IS NOT NULL`,
    `${tagCheckField} != ''`,
    ...placeholderClauses,
  ].join(' AND ');

  const sql = `
    WITH resources AS (
      SELECT
        account_id,
        account_name,
        service,
        service_family,
        resource_id,
        SUM(cost) AS cost,
        MAX(CASE WHEN ${isTaggedExpr} THEN 1 ELSE 0 END) AS has_tag,
        MAX(${tagResolved.rawField}) AS closest_owner
      FROM ${source}
      WHERE ${whereConditions.join(' AND ')}
      GROUP BY account_id, account_name, service, service_family, resource_id
    ),
    category_coverage AS (
      SELECT
        service,
        service_family,
        CASE
          WHEN SUM(cost) > 0 THEN SUM(CASE WHEN has_tag = 1 THEN cost ELSE 0 END) / SUM(cost)
          ELSE 0
        END AS tagged_ratio
      FROM resources
      GROUP BY service, service_family
    )
    SELECT
      r.account_id,
      r.account_name,
      r.resource_id,
      r.service,
      r.service_family,
      r.cost,
      r.closest_owner,
      c.tagged_ratio,
      CASE WHEN c.tagged_ratio > 0 THEN 'actionable' ELSE 'likely-untaggable' END AS bucket
    FROM resources r
    JOIN category_coverage c USING (service, service_family)
    WHERE r.has_tag = 0
    ORDER BY r.cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

/**
 * Non-resource cost: everything that's NOT a resource-bound Usage line.
 *   - line_item_type not in (Usage, DiscountedUsage): tax, support, fees,
 *     credits, savings-plan recurring fees, bundled discounts, etc.
 *   - resource_id empty on a Usage line: some data-transfer and misc charges
 *     are Usage but have no resource to attach tags to.
 *
 * Returns cost by (service, service_family, line_item_type) for a sidebar
 * breakdown. These totals reconcile against the cost overview but are
 * inherently un-taggable at the resource level.
 */
export function buildNonResourceCostQuery(
  params: MissingTagsParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, 'daily', opts);

  const whereConditions = [
    buildDateRangeWhere(qb, params.dateRange),
    `(line_item_type NOT IN ('Usage', 'DiscountedUsage') OR resource_id IS NULL OR resource_id = '')`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  const sql = `
    SELECT
      service,
      service_family,
      line_item_type,
      SUM(cost) AS cost
    FROM ${source}
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY service, service_family, line_item_type
    HAVING SUM(cost) > 0
    ORDER BY cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

export function buildDailyCostsQuery(
  params: DailyCostsParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  const dailyTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const resolvedTier = effectiveTier(dailyTier, params.dateRange);
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, dailyTier, opts);
  const groupByResolved = resolveField(params.groupBy, opts.dimensions);

  const whereConditions = [
    buildDateRangeWhere(qb, params.dateRange),
    ...filterClauses,
    ...exclusionClauses,
  ];

  // Round CUR's mid-hour fee timestamps (SavingsPlanFee, RIFee, Tax, etc.)
  // to the nearest hour boundary so they land in a single bucket alongside
  // hour-aligned Usage rows instead of polluting the histogram.
  const dateExpr = resolvedTier === 'hourly'
    ? "strftime(date_trunc('hour', usage_hour + INTERVAL '30 minutes'), '%Y-%m-%d %H:00')"
    : 'usage_date::VARCHAR';

  const sql = `
    SELECT
      ${dateExpr} AS date,
      ${groupByResolved.fieldExpr} AS group_name,
      SUM(cost) AS cost
    FROM ${source}
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY date, group_name
    ORDER BY date, cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

export function buildEntityDetailQuery(
  params: EntityDetailParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  const granularity = params.granularity ?? 'daily';
  const tier = granularity === 'hourly' ? 'hourly' : 'daily';
  const resolvedTier = effectiveTier(tier, params.dateRange);
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, tier, opts);
  const dimResolved = resolveField(params.dimension, opts.dimensions);

  // Same display-name collision treatment for the entity selector itself: if
  // the user clicked into "sre default" we need to match every underlying id,
  // not just one.
  const entityClause = (() => {
    if (dimResolved.rawField === 'account_id' && opts.accountReverseMap !== undefined) {
      const ids = opts.accountReverseMap.get(String(params.entity));
      if (ids !== undefined && ids.length > 0) {
        const placeholders = ids.map(id => qb.addParam(id)).join(', ');
        return `${dimResolved.rawField} IN (${placeholders})`;
      }
    }
    const entityPlaceholder = qb.addParam(String(params.entity));
    return `${dimResolved.fieldExpr} = ${entityPlaceholder}`;
  })();

  const whereConditions = [
    buildDateRangeWhere(qb, params.dateRange),
    entityClause,
    ...filterClauses,
    ...exclusionClauses,
  ];

  // Group by hour for hourly tier so the entity detail histogram doesn't
  // collapse 24 hourly rows into one date row. Mid-hour fee timestamps are
  // rounded to the nearest hour boundary (see buildDailyCostsQuery comment).
  const groupKey = resolvedTier === 'hourly'
    ? "strftime(date_trunc('hour', usage_hour + INTERVAL '30 minutes'), '%Y-%m-%d %H:00')"
    : 'usage_date::VARCHAR';

  const sql = `
    SELECT
      ${groupKey} AS usage_date,
      service,
      account_id,
      account_name,
      SUM(cost) AS cost
    FROM ${source}
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY ${groupKey}, service, account_id, account_name
    ORDER BY usage_date, cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

/** Build a DDL statement that materializes the base source into a temp table.
 *  Uses escaped literals instead of parameterized placeholders because DuckDB
 *  does not support prepared DDL. All values originate from app config (cost
 *  scope rules, computed date range), not from user input. */
export function buildMaterializeBaseQuery(
  tier: string,
  dateRange: { readonly start: string; readonly end: string },
  opts: QueryContextOptions,
): string {
  const { dataDir, dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns } = opts;
  const exclusionClauses: string[] = [];
  if (costScope !== undefined) {
    for (const rule of costScope.rules) {
      if (!rule.enabled) continue;
      const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
      if (matchExpr === null) continue;
      exclusionClauses.push(`NOT (${matchExpr})`);
    }
  }
  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';
  const periods = resolveQueryPeriods(dateRange, availablePeriods);
  const source = buildSource({ dataDir, tier, dimensions, orgAccountsPath, periods, costMetric, availableColumns, costPerspective, marketplaceAttribution: costScope?.marketplaceAttribution, includeRawTags: true, slim: true });

  assertDateString(dateRange.start);
  assertDateString(dateRange.end);

  const whereConditions = [
    `usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`,
    ...exclusionClauses,
  ];

  return `CREATE OR REPLACE TABLE cost_base AS SELECT * FROM ${source} WHERE ${whereConditions.join(' AND ')}`;
}

/** First day of the month after `period` (YYYY-MM), as a YYYY-MM-DD upper bound
 *  (exclusive) for that period's day range. */
function periodUpperBound(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** Build the DDL that materializes ONE month's PRE-AGGREGATED rollup partition
 *  to Parquet. Grain = usage_date + enabled dimension columns (see
 *  `rollupGrainColumns`); measures = SUM(cost) + COUNT(*) AS line_items. The
 *  active cost metric/perspective are baked into `cost`, exclusion rows are
 *  dropped at build time, and ALL days are ingested (lagDays stays a query-time
 *  filter). Dimension values are stored RAW — aliasing remains query-time.
 *
 *  `buildSource` runs over the FULL dimensions (so exclusion rules referencing
 *  a disabled dim such as line_item_type still resolve); the GROUP BY is what
 *  collapses non-grain columns away.
 *
 *  Like buildMaterializeBaseQuery this interpolates escaped literals (DuckDB
 *  has no prepared DDL); `period` is validated and `outPath` is app-controlled
 *  and quote-escaped. */
export function buildRollupPartitionQuery(
  period: string,
  tier: string,
  outPath: string,
  opts: QueryContextOptions,
): string {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new SecurityError(`Invalid rollup period "${period}" — expected YYYY-MM.`);
  }
  const { dataDir, dimensions, orgAccountsPath, accountReverseMap, costScope, availableColumns } = opts;
  const grain = rollupGrainColumns(dimensions);
  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';

  const source = buildSource({
    dataDir, tier, dimensions, orgAccountsPath, periods: [period],
    costMetric, availableColumns, costPerspective,
    marketplaceAttribution: costScope?.marketplaceAttribution,
    includeRawTags: false, slim: true,
  });

  const exclusionClauses: string[] = [];
  if (costScope !== undefined) {
    for (const rule of costScope.rules) {
      if (!rule.enabled) continue;
      const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
      if (matchExpr === null) continue;
      exclusionClauses.push(`NOT (${matchExpr})`);
    }
  }

  const start = `${period}-01`;
  const end = periodUpperBound(period);
  assertDateString(start);
  assertDateString(end);

  const whereConditions = [`usage_date >= '${start}'`, `usage_date < '${end}'`, ...exclusionClauses];
  const groupBy = grain.join(', ');
  const select =
    `SELECT ${groupBy}, CAST(SUM(cost) AS DOUBLE) AS cost, CAST(COUNT(*) AS BIGINT) AS line_items ` +
    `FROM ${source} WHERE ${whereConditions.join(' AND ')} GROUP BY ${groupBy}`;
  const escapedPath = outPath.replaceAll("'", "''");
  return `COPY (${select}) TO '${escapedPath}' (FORMAT PARQUET)`;
}

/** Build the cardinality probe behind the grain cost/benefit estimator (rollup
 *  design §8). Over ONE recent month it returns, in a single scan:
 *   - `line_items`  — COUNT(*) (the rollup's raw input for that month),
 *   - `grain_rows`  — exact `COUNT(DISTINCT)` of the candidate grain tuple
 *      (the rollup row count for that month), and
 *   - `card_<i>`    — exact distinct count of each enabled dimension's primary
 *      column, so the estimator can flag individual raw-only dims (e.g. resource_id), and
 *   - `loo_<i>`     — the grain row count with that whole dimension removed (a
 *      built-in drops both its id and display column), so the estimator can
 *      attribute marginal rollup size per dimension. Indexed by
 *      `rollupGrainDimensions` order (built-ins first, then tags).
 *
 *  Counts are EXACT (not HyperLogLog): the per-dimension multiplier is a ratio
 *  of two distinct-counts, and approx error compounds across the ratio. Exact is
 *  monotonic (a leave-one-out can only lower the count), so multipliers are ≥ 1.
 *
 *  `grainColumns` come from `rollupGrainColumns` over the candidate dimensions
 *  (usage_date first) and are projected by `buildSource` — the same trusted set
 *  `buildRollupPartitionQuery` interpolates. Exclusion rows are dropped so the
 *  counts match what the rollup would actually store. `chr(31)` (unit separator)
 *  joins the tuple so distinct values never collide across columns. */
export function buildGrainProbeQuery(
  period: string,
  grainColumns: readonly string[],
  opts: QueryContextOptions,
): string {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new SecurityError(`Invalid probe period "${period}" — expected YYYY-MM.`);
  }
  const { dataDir, dimensions, orgAccountsPath, accountReverseMap, costScope, availableColumns } = opts;
  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';

  const source = buildSource({
    dataDir, tier: 'daily', dimensions, orgAccountsPath, periods: [period],
    costMetric, availableColumns, costPerspective,
    marketplaceAttribution: costScope?.marketplaceAttribution,
    includeRawTags: false, slim: true,
  });

  const exclusionClauses: string[] = [];
  if (costScope !== undefined) {
    for (const rule of costScope.rules) {
      if (!rule.enabled) continue;
      const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
      if (matchExpr === null) continue;
      exclusionClauses.push(`NOT (${matchExpr})`);
    }
  }

  const start = `${period}-01`;
  const end = periodUpperBound(period);
  assertDateString(start);
  assertDateString(end);
  const whereConditions = [`usage_date >= '${start}'`, `usage_date < '${end}'`, ...exclusionClauses];

  const grainConcat = `concat_ws(chr(31), ${grainColumns.join(', ')})`;
  // Per-dimension cardinality and leave-one-out grain. card_<i> is the
  // dimension's own distinct count; loo_<i> is the grain with that whole
  // dimension removed — a built-in drops both its id and its display column, so
  // a 1:1 display column (account_name ↔ account_id) isn't split into two
  // mutually-covering pseudo-dims. The estimator turns fullGrain ÷ loo_<i> into
  // the marginal rollup size each dimension drives — a correlation-aware impact,
  // computed in this same single scan. Same trusted grainColumns interpolation
  // as grainConcat above (no user values).
  //
  // EXACT COUNT(DISTINCT), not approx_count_distinct: the marginal multiplier is
  // a ratio of two distinct-counts, and HyperLogLog error (measured 6–13% on
  // real CUR data) compounds across the ratio, fabricating spurious ×1.1–×1.5
  // impacts for near-redundant dims. Exact counts are monotonic (loo ≤ grain),
  // so multipliers are naturally ≥ 1, and cost only a single extra month-scan.
  const grainDims = rollupGrainDimensions(dimensions);
  const cardSelects = grainDims.map((dim, i) => `CAST(COUNT(DISTINCT ${dim.column}) AS BIGINT) AS card_${String(i)}`);
  const looSelects = grainDims.map((dim, i) => {
    const remove = new Set(dim.columns);
    const cols = grainColumns.filter(g => !remove.has(g));
    return `CAST(COUNT(DISTINCT concat_ws(chr(31), ${cols.join(', ')})) AS BIGINT) AS loo_${String(i)}`;
  });
  const selects = [
    `CAST(COUNT(*) AS BIGINT) AS line_items`,
    `CAST(COUNT(DISTINCT ${grainConcat}) AS BIGINT) AS grain_rows`,
    ...cardSelects,
    ...looSelects,
  ];
  return `SELECT ${selects.join(', ')} FROM ${source} WHERE ${whereConditions.join(' AND ')}`;
}
