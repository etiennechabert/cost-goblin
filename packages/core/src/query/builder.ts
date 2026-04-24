import type { BuiltInDimension, DimensionsConfig, TagDimension } from '../types/config.js';
import type { CostQueryParams, DailyCostsParams, FilterMap, TrendQueryParams, MissingTagsParams, EntityDetailParams } from '../types/query.js';
import type { DimensionId } from '../types/branded.js';
import { tagColumnName } from '../types/branded.js';
import type { CostMetric, CostPerspective, CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import { buildAliasSqlCase, normalizeTagValue, resolveAlias } from '../normalize/normalize.js';
import { costExprFor } from './cost-metric.js';
import { QueryBuilder, type ParameterizedQuery } from './parameterized.js';
import { SecurityError } from './identifier-validator.js';

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Query parameter "${name}" must be a non-negative finite number, got ${String(value)}`);
  }
}

function sqlEscapeString(value: string): string {
  return value.replace(/'/g, "''");
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

  const tag = dimensions.tags.find(d => tagColumnName(d.tagName) === dimensionId);
  if (tag !== undefined) {
    const rawField = tagColumnName(tag.tagName);
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

function buildFilterClauses(
  filters: FilterMap,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  qb: QueryBuilder,
): string[] {
  const clauses: string[] = [];
  for (const [dimId, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    const resolved = resolveField(dimId as DimensionId, dimensions);
    if (resolved.rawField === 'account_id' && accountReverseMap !== undefined) {
      const ids = accountReverseMap.get(String(value));
      if (ids !== undefined && ids.length > 0) {
        const list = buildSqlList(ids, qb);
        clauses.push(`${resolved.rawField} IN (${list})`);
        continue;
      }
    }
    const placeholder = qb.addParam(String(value));
    clauses.push(`${resolved.fieldExpr} = ${placeholder}`);
  }
  return clauses;
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
    if (cond.values.length === 0) continue;
    // Skip conditions whose dimension no longer exists — happens if a user
    // deletes/renames a dimension while a rule references it. Emitting a
    // bogus column reference here would crash every query that threads cost
    // scope through (which is all of them). Save-time validation prevents
    // this on new edits; this guard covers legacy on-disk rules.
    const resolved = tryResolveField(cond.dimensionId, dimensions);
    if (resolved === null) continue;
    if (resolved.rawField === 'account_id' && accountReverseMap !== undefined) {
      const expandedIds = new Set<string>();
      let usedReverse = false;
      for (const v of cond.values) {
        const ids = accountReverseMap.get(v);
        if (ids !== undefined && ids.length > 0) {
          for (const id of ids) expandedIds.add(id);
          usedReverse = true;
        } else {
          expandedIds.add(v);
        }
      }
      if (usedReverse) {
        const list = buildSqlList([...expandedIds], qb);
        conditionSqls.push(`${resolved.rawField} IN (${list})`);
        continue;
      }
    }
    // Apply the dim's normalize + alias transformation to each value so
    // rule conditions stay correct when the user normalises the target
    // dimension (e.g. a lowercase rule on `line_item_type` would otherwise
    // turn 'RIFee' in the built-in rule into a silent no-match). The
    // field expression already bakes in the same transformation.
    const normalizedValues = cond.values.map(v => normalizeRuleValue(v, resolved.dim));
    const list = buildSqlList(normalizedValues, qb);
    conditionSqls.push(`${resolved.fieldExpr} IN (${list})`);
  }
  if (conditionSqls.length === 0) return null;
  return conditionSqls.join(' AND ');
}

function buildExclusionClauses(
  rules: readonly ExclusionRule[],
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  qb: QueryBuilder,
): string[] {
  const clauses: string[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
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
export function buildSource(
  dataDir: string,
  tier: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  periods?: readonly string[],
  costMetric: CostMetric = 'unblended',
  availableColumns?: ReadonlySet<string>,
  costPerspective?: CostPerspective,
): string {
  const hasFallbacks = dimensions.tags.some(t => t.accountTagFallback !== undefined);
  const needsOrgJoin = hasFallbacks && orgAccountsPath !== undefined;

  const tagSelects = dimensions.tags.map(t => {
    const curKey = t.tagName.startsWith('user_') ? t.tagName : `user_${t.tagName}`;
    const colName = tagColumnName(t.tagName);
    const tablePrefix = needsOrgJoin ? 'cur.' : '';
    const resourceExpr = `element_at(${tablePrefix}resource_tags, '${curKey}')[1]`;

    if (t.accountTagFallback !== undefined && needsOrgJoin) {
      const fallbackExpr = `acct_tags.fallback_${colName}`;
      // Apply missingValueTemplate if set — e.g. "unknown-{fallback}" → 'unknown-' || account_tag
      if (t.missingValueTemplate !== undefined && t.missingValueTemplate.length > 0 && t.missingValueTemplate !== '{fallback}') {
        const parts = t.missingValueTemplate.split('{fallback}');
        const prefix = sqlEscapeString(parts[0] ?? '');
        const suffix = sqlEscapeString(parts[1] ?? '');
        const formatted = `'${prefix}' || ${fallbackExpr} || '${suffix}'`;
        return `COALESCE(NULLIF(${resourceExpr}, ''), ${formatted}) AS ${colName}`;
      }
      return `COALESCE(NULLIF(${resourceExpr}, ''), ${fallbackExpr}) AS ${colName}`;
    }

    return `${resourceExpr} AS ${colName}`;
  });

  const tagClause = tagSelects.length > 0 ? `,\n      ${tagSelects.join(',\n      ')}` : '';

  // usage_date is always DATE so date-range filters work consistently across
  // tiers (BETWEEN against a TIMESTAMP truncates 'YYYY-MM-DD' to midnight and
  // would silently drop ~23h of rows on the end day). For hourly we additionally
  // expose usage_hour as a standard TIMESTAMP — the source column is TIMESTAMP_NS
  // (nanoseconds) in CUR and the @duckdb/node-api row converter doesn't know
  // how to serialize that variant; casting to plain TIMESTAMP fixes it.
  const dateExpr = tier === 'hourly'
    ? 'line_item_usage_start_date::DATE AS usage_date,\n      line_item_usage_start_date::TIMESTAMP AS usage_hour'
    : 'line_item_usage_start_date::DATE AS usage_date';

  const parquetSource = periods !== undefined && periods.length > 0
    ? `read_parquet([${periods.map(p => `'${dataDir}/aws/raw/${tier}-${p}/*.parquet'`).join(', ')}])`
    : `read_parquet('${dataDir}/aws/raw/${tier}-*/*.parquet')`;

  // Build fallback column extractions for the org-accounts join
  const fallbackSelects = needsOrgJoin
    ? dimensions.tags
        .filter(t => t.accountTagFallback !== undefined)
        .map(t => {
          const colName = tagColumnName(t.tagName);
          const fallbackKey = sqlEscapeString(t.accountTagFallback ?? '');
          return `tags->>'${fallbackKey}' AS fallback_${colName}`;
        })
    : [];

  const fromClause = needsOrgJoin
    ? `${parquetSource} AS cur
      LEFT JOIN (
        SELECT id, ${fallbackSelects.join(', ')}
        FROM read_json_auto('${orgAccountsPath}')
      ) AS acct_tags ON cur.line_item_usage_account_id = acct_tags.id`
    : parquetSource;

  const tablePrefix = needsOrgJoin ? 'cur.' : '';
  const costExpr = costExprFor(costMetric, tablePrefix, costPerspective, availableColumns);

  return `(
    SELECT
      ${dateExpr},
      ${tablePrefix}line_item_usage_account_id AS account_id,
      COALESCE(${tablePrefix}line_item_usage_account_name, '') AS account_name,
      COALESCE(${tablePrefix}product_region_code, '') AS region,
      COALESCE(${tablePrefix}product_servicecode, '') AS service,
      COALESCE(${tablePrefix}product_product_family, '') AS service_family,
      COALESCE(${tablePrefix}line_item_line_item_description, '') AS description,
      COALESCE(${tablePrefix}line_item_resource_id, '') AS resource_id,
      COALESCE(${tablePrefix}line_item_usage_amount, 0) AS usage_amount,
      ${costExpr} AS cost,
      COALESCE(${tablePrefix}pricing_public_on_demand_cost, 0) AS list_cost,
      COALESCE(${tablePrefix}line_item_line_item_type, '') AS line_item_type,
      COALESCE(${tablePrefix}line_item_operation, '') AS operation,
      COALESCE(${tablePrefix}line_item_usage_type, '') AS usage_type${tagClause}
    FROM ${fromClause}
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

interface CommonQueryArgs {
  readonly filters: FilterMap;
  readonly dateRange: { readonly start: string; readonly end: string };
}

interface CommonQuerySetup {
  readonly qb: QueryBuilder;
  readonly filterClauses: string[];
  readonly exclusionClauses: string[];
  readonly source: string;
  readonly costMetric: CostMetric;
}

function setupQuery(
  params: CommonQueryArgs,
  dataDir: string,
  tier: string,
  dimensions: DimensionsConfig,
  orgAccountsPath: string | undefined,
  availablePeriods: readonly string[] | undefined,
  accountReverseMap: ReadonlyMap<string, readonly string[]> | undefined,
  costScope: CostScopeConfig | undefined,
  availableColumns: ReadonlySet<string> | undefined,
): CommonQuerySetup {
  const qb = new QueryBuilder();
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap, qb);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap, qb) : [];
  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';
  const periods = resolveQueryPeriods(params.dateRange, availablePeriods);
  const source = buildSource(dataDir, tier, dimensions, orgAccountsPath, periods, costMetric, availableColumns, costPerspective);
  return { qb, filterClauses, exclusionClauses, source, costMetric };
}

export function buildCostQuery(
  params: CostQueryParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  topN: number = 5,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
  availableColumns?: ReadonlySet<string>,
): ParameterizedQuery {
  assertFiniteNumber(topN, 'topN');
  const costTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, dataDir, costTier, dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns);
  const groupByResolved = resolveField(params.groupBy, dimensions);

  const startDatePlaceholder = qb.addParam(params.dateRange.start);
  const endDatePlaceholder = qb.addParam(params.dateRange.end);
  const whereConditions = [
    `usage_date BETWEEN ${startDatePlaceholder} AND ${endDatePlaceholder}`,
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
    ),
    entity_services AS (
      SELECT
        b.entity,
        b.service,
        SUM(b.cost) AS service_cost
      FROM base b
      INNER JOIN top_services ts ON b.service = ts.service
      GROUP BY b.entity, b.service
    )
    SELECT
      et.entity,
      et.total_cost,
      es.service,
      COALESCE(es.service_cost, 0) AS service_cost
    FROM entity_totals et
    LEFT JOIN entity_services es ON et.entity = es.entity
    ORDER BY et.total_cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

export function buildTrendQuery(
  params: TrendQueryParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
  availableColumns?: ReadonlySet<string>,
): ParameterizedQuery {
  assertFiniteNumber(Number(params.deltaThreshold), 'deltaThreshold');
  const qb = new QueryBuilder();
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap, qb);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap, qb) : [];
  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';

  const startDate = params.dateRange.start;
  const endDate = params.dateRange.end;

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
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath, periods, costMetric, availableColumns, costPerspective);

  const allFilterClauses = [...filterClauses, ...exclusionClauses];
  const filterWhere = allFilterClauses.length > 0 ? ` AND ${allFilterClauses.join(' AND ')}` : '';

  const startDatePlaceholder = qb.addParam(startDate);
  const endDatePlaceholder = qb.addParam(endDate);
  const deltaThresholdPlaceholder = qb.addParam(Number(params.deltaThreshold));

  const sql = `
    WITH current_period AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        SUM(cost) AS total_cost
      FROM ${source}
      WHERE usage_date BETWEEN ${startDatePlaceholder} AND ${endDatePlaceholder}${filterWhere}
      GROUP BY entity
    ),
    period_length AS (
      SELECT DATEDIFF('day', CAST(${startDatePlaceholder} AS DATE), CAST(${endDatePlaceholder} AS DATE)) + 1 AS days
    ),
    previous_period AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        SUM(cost) AS total_cost
      FROM ${source}
      WHERE usage_date BETWEEN
        CAST(${startDatePlaceholder} AS DATE) - (SELECT days FROM period_length) * INTERVAL '1 day'
        AND CAST(${startDatePlaceholder} AS DATE) - INTERVAL '1 day'${filterWhere}
      GROUP BY entity
    )
    SELECT
      COALESCE(c.entity, p.entity) AS entity,
      COALESCE(c.total_cost, 0) AS current_cost,
      COALESCE(p.total_cost, 0) AS previous_cost,
      COALESCE(c.total_cost, 0) - COALESCE(p.total_cost, 0) AS delta,
      CASE
        WHEN COALESCE(p.total_cost, 0) = 0 THEN NULL
        ELSE (COALESCE(c.total_cost, 0) - p.total_cost) / p.total_cost * 100
      END AS percent_change
    FROM current_period c
    FULL OUTER JOIN previous_period p ON c.entity = p.entity
    WHERE ABS(COALESCE(c.total_cost, 0) - COALESCE(p.total_cost, 0)) >= ${deltaThresholdPlaceholder}
    ORDER BY ABS(COALESCE(c.total_cost, 0) - COALESCE(p.total_cost, 0)) DESC
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
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
  availableColumns?: ReadonlySet<string>,
): ParameterizedQuery {
  assertFiniteNumber(Number(params.minCost), 'minCost');
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, dataDir, 'daily', dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns);
  const tagResolved = resolveField(params.tagDimension, dimensions);

  const startDatePlaceholder = qb.addParam(params.dateRange.start);
  const endDatePlaceholder = qb.addParam(params.dateRange.end);
  const whereConditions = [
    `usage_date BETWEEN ${startDatePlaceholder} AND ${endDatePlaceholder}`,
    `line_item_type IN ('Usage', 'DiscountedUsage')`,
    `resource_id IS NOT NULL AND resource_id != ''`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  const minCostPlaceholder = qb.addParam(Number(params.minCost));

  const sql = `
    WITH resources AS (
      SELECT
        account_id,
        account_name,
        service,
        service_family,
        resource_id,
        SUM(cost) AS cost,
        MAX(CASE WHEN ${tagResolved.rawField} IS NOT NULL AND ${tagResolved.rawField} != '' THEN 1 ELSE 0 END) AS has_tag
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
      c.tagged_ratio,
      CASE WHEN c.tagged_ratio > 0 THEN 'actionable' ELSE 'likely-untaggable' END AS bucket
    FROM resources r
    JOIN category_coverage c USING (service, service_family)
    WHERE r.has_tag = 0
      AND r.cost >= ${minCostPlaceholder}
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
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
  availableColumns?: ReadonlySet<string>,
): ParameterizedQuery {
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, dataDir, 'daily', dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns);

  const startDatePlaceholder = qb.addParam(params.dateRange.start);
  const endDatePlaceholder = qb.addParam(params.dateRange.end);
  const whereConditions = [
    `usage_date BETWEEN ${startDatePlaceholder} AND ${endDatePlaceholder}`,
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
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
  availableColumns?: ReadonlySet<string>,
): ParameterizedQuery {
  const dailyTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, dataDir, dailyTier, dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns);
  const groupByResolved = resolveField(params.groupBy, dimensions);

  const startDatePlaceholder = qb.addParam(params.dateRange.start);
  const endDatePlaceholder = qb.addParam(params.dateRange.end);
  const whereConditions = [
    `usage_date BETWEEN ${startDatePlaceholder} AND ${endDatePlaceholder}`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  const dateExpr = dailyTier === 'hourly'
    ? "strftime(usage_hour, '%Y-%m-%d %H:00')"
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
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
  availableColumns?: ReadonlySet<string>,
): ParameterizedQuery {
  const granularity = params.granularity ?? 'daily';
  const tier = granularity === 'hourly' ? 'hourly' : 'daily';
  const { qb, filterClauses, exclusionClauses, source } = setupQuery(params, dataDir, tier, dimensions, orgAccountsPath, availablePeriods, accountReverseMap, costScope, availableColumns);
  const dimResolved = resolveField(params.dimension, dimensions);

  // Same display-name collision treatment for the entity selector itself: if
  // the user clicked into "sre default" we need to match every underlying id,
  // not just one.
  const entityClause = (() => {
    if (dimResolved.rawField === 'account_id' && accountReverseMap !== undefined) {
      const ids = accountReverseMap.get(String(params.entity));
      if (ids !== undefined && ids.length > 0) {
        const placeholders = ids.map(id => qb.addParam(id)).join(', ');
        return `${dimResolved.rawField} IN (${placeholders})`;
      }
    }
    const entityPlaceholder = qb.addParam(String(params.entity));
    return `${dimResolved.fieldExpr} = ${entityPlaceholder}`;
  })();

  const startDatePlaceholder = qb.addParam(params.dateRange.start);
  const endDatePlaceholder = qb.addParam(params.dateRange.end);
  const whereConditions = [
    `usage_date BETWEEN ${startDatePlaceholder} AND ${endDatePlaceholder}`,
    entityClause,
    ...filterClauses,
    ...exclusionClauses,
  ];

  // Group by hour for hourly tier so the entity detail histogram doesn't
  // collapse 24 hourly rows into one date row.
  const groupKey = tier === 'hourly'
    ? "strftime(usage_hour, '%Y-%m-%d %H:00')"
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
