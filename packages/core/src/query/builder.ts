import type { DimensionsConfig, TagDimension } from '../types/config.js';
import type { CostQueryParams, DailyCostsParams, FilterMap, TrendQueryParams, MissingTagsParams, EntityDetailParams } from '../types/query.js';
import type { DimensionId } from '../types/branded.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import { buildAliasSqlCase } from '../normalize/normalize.js';
import { costColumnFor } from './cost-metric.js';

/**
 * When all raw files for a query's periods have fresh combined sidecars, the
 * handler builds this plan and passes it through to buildSource, which then
 * emits a single POSITIONAL JOIN instead of per-row element_at() lookups.
 *
 * `rawFiles` and `sidecarFiles` must be the same length and in matching order
 * — POSITIONAL JOIN pairs rows by position, and concatenates file reads in
 * list order, so a single misalignment breaks every subsequent row. Each
 * sidecar file is a wide Parquet with one column per configured tag dim.
 */
export interface SidecarPlan {
  readonly rawFiles: readonly string[];
  readonly sidecarFiles: readonly string[];
}

function tagColumnNameFromTag(t: TagDimension): string {
  return `tag_${t.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
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
}

function tryResolveField(dimensionId: DimensionId, dimensions: DimensionsConfig): ResolvedDimension | null {
  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  if (builtIn !== undefined) {
    // Built-ins now support normalize + aliases just like tags; apply them at
    // query time via the same CASE/LOWER(...) machinery.
    const fieldExpr = buildAliasSqlCase(builtIn.field, builtIn);
    return { fieldExpr, rawField: builtIn.field };
  }

  const tag = dimensions.tags.find(d => `tag_${d.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === dimensionId);
  if (tag !== undefined) {
    const rawField = `tag_${tag.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return { fieldExpr: buildAliasSqlCase(rawField, tag), rawField };
  }

  return null;
}

function resolveField(dimensionId: DimensionId, dimensions: DimensionsConfig): ResolvedDimension {
  const resolved = tryResolveField(dimensionId, dimensions);
  if (resolved !== null) return resolved;
  // Fallback: used by filter/orgNode paths where the caller has already
  // validated the id exists. For exclusion rules we go through
  // tryResolveField directly so a stale reference doesn't emit a bogus
  // column name that would crash every query.
  return { fieldExpr: dimensionId, rawField: dimensionId };
}

function buildFilterClauses(
  filters: FilterMap,
  dimensions: DimensionsConfig,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
): string[] {
  const clauses: string[] = [];
  for (const [dimId, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    const resolved = resolveField(dimId as DimensionId, dimensions);
    // Account dim with display-name collisions: the user picks "sre default"
    // in the filter dropdown, but that collapses N underlying ids. Match any
    // of them with an IN clause. Falls through to '=' when the value isn't a
    // known display name (raw id, or no map provided).
    if (resolved.rawField === 'account_id' && accountReverseMap !== undefined) {
      const ids = accountReverseMap.get(String(value));
      if (ids !== undefined && ids.length > 0) {
        const list = ids.map(id => `'${id.replaceAll("'", "''")}'`).join(', ');
        clauses.push(`${resolved.rawField} IN (${list})`);
        continue;
      }
    }
    clauses.push(`${resolved.fieldExpr} = '${String(value).replaceAll("'", "''")}'`);
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
        const list = [...expandedIds].map(id => `'${id.replaceAll("'", "''")}'`).join(', ');
        conditionSqls.push(`${resolved.rawField} IN (${list})`);
        continue;
      }
    }
    const list = cond.values.map(v => `'${v.replaceAll("'", "''")}'`).join(', ');
    conditionSqls.push(`${resolved.fieldExpr} IN (${list})`);
  }
  if (conditionSqls.length === 0) return null;
  return conditionSqls.join(' AND ');
}

function buildExclusionClauses(
  rules: readonly ExclusionRule[],
  dimensions: DimensionsConfig,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
): string[] {
  const clauses: string[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap);
    if (matchExpr === null) continue;
    clauses.push(`NOT (${matchExpr})`);
  }
  return clauses;
}

function quoteList(paths: readonly string[]): string {
  return `[${paths.map(p => `'${p}'`).join(', ')}]`;
}

/**
 * Sidecar-mode source: a single POSITIONAL JOIN against the wide combined
 * sidecar. Pairs each raw file with its sidecar by list position; the sidecar
 * holds one column per configured tag dim. Replaces per-row element_at(map, key)
 * lookups with a flat column read.
 *
 * Drops the org-accounts JOIN entirely — fallback logic was baked into each
 * sidecar column at generation time.
 */
function buildSourceFromSidecars(tier: string, dimensions: DimensionsConfig, plan: SidecarPlan, costColumn: string): string {
  const rawList = quoteList(plan.rawFiles);
  const sidecarList = quoteList(plan.sidecarFiles);

  const tagSelects = dimensions.tags.map(t => {
    const colName = tagColumnNameFromTag(t);
    return `side.${colName} AS ${colName}`;
  });
  const tagClause = tagSelects.length > 0 ? `,\n      ${tagSelects.join(',\n      ')}` : '';
  const joinClause = dimensions.tags.length > 0
    ? `\n      POSITIONAL JOIN read_parquet(${sidecarList}) AS side`
    : '';

  const dateExpr = tier === 'hourly'
    ? 'line_item_usage_start_date::DATE AS usage_date,\n      line_item_usage_start_date::TIMESTAMP AS usage_hour'
    : 'line_item_usage_start_date::DATE AS usage_date';

  return `(
    SELECT
      ${dateExpr},
      cur.line_item_usage_account_id AS account_id,
      COALESCE(cur.line_item_usage_account_name, '') AS account_name,
      COALESCE(cur.product_region_code, '') AS region,
      COALESCE(cur.product_servicecode, '') AS service,
      COALESCE(cur.product_product_family, '') AS service_family,
      COALESCE(cur.line_item_line_item_description, '') AS description,
      COALESCE(cur.line_item_resource_id, '') AS resource_id,
      COALESCE(cur.line_item_usage_amount, 0) AS usage_amount,
      COALESCE(cur.${costColumn}, 0) AS cost,
      COALESCE(cur.pricing_public_on_demand_cost, 0) AS list_cost,
      COALESCE(cur.line_item_line_item_type, '') AS line_item_type,
      COALESCE(cur.line_item_operation, '') AS operation,
      COALESCE(cur.line_item_usage_type, '') AS usage_type${tagClause}
    FROM read_parquet(${rawList}) AS cur${joinClause}
  )`;
}

/**
 * Build the Parquet source subquery. Three modes:
 *   1. sidecar mode (plan provided): POSITIONAL JOIN with pre-computed tag
 *      columns. Dramatically faster on tag-heavy queries — column scan vs
 *      per-row map lookup.
 *   2. narrowed wildcard (periods provided): read_parquet on explicit month
 *      directories. Element_at at query time, but cuts Parquet footer reads.
 *   3. full wildcard (neither): daily-*\/*.parquet. Original path.
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
  sidecarPlan?: SidecarPlan,
  costColumn: string = 'line_item_unblended_cost',
): string {
  if (sidecarPlan !== undefined) {
    return buildSourceFromSidecars(tier, dimensions, sidecarPlan, costColumn);
  }
  const hasFallbacks = dimensions.tags.some(t => t.accountTagFallback !== undefined);
  const needsOrgJoin = hasFallbacks && orgAccountsPath !== undefined;

  const tagSelects = dimensions.tags.map(t => {
    const curKey = `user_${t.tagName}`;
    const colName = `tag_${t.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const tablePrefix = needsOrgJoin ? 'cur.' : '';
    const resourceExpr = `element_at(${tablePrefix}resource_tags, '${curKey}')[1]`;

    if (t.accountTagFallback !== undefined && needsOrgJoin) {
      const fallbackExpr = `acct_tags.fallback_${colName}`;
      // Apply missingValueTemplate if set — e.g. "unknown-{fallback}" → 'unknown-' || account_tag
      if (t.missingValueTemplate !== undefined && t.missingValueTemplate.length > 0 && t.missingValueTemplate !== '{fallback}') {
        const parts = t.missingValueTemplate.split('{fallback}');
        const prefix = (parts[0] ?? '').replaceAll("'", "''");
        const suffix = (parts[1] ?? '').replaceAll("'", "''");
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
          const colName = `tag_${t.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
          const fallbackKey = (t.accountTagFallback ?? '').replaceAll("'", "''");
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

  return `(
    SELECT
      ${dateExpr},
      ${needsOrgJoin ? 'cur.' : ''}line_item_usage_account_id AS account_id,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_usage_account_name, '') AS account_name,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}product_region_code, '') AS region,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}product_servicecode, '') AS service,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}product_product_family, '') AS service_family,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_line_item_description, '') AS description,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_resource_id, '') AS resource_id,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_usage_amount, 0) AS usage_amount,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}${costColumn}, 0) AS cost,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}pricing_public_on_demand_cost, 0) AS list_cost,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_line_item_type, '') AS line_item_type,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_operation, '') AS operation,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_usage_type, '') AS usage_type${tagClause}
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

export function buildCostQuery(
  params: CostQueryParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  topN: number = 5,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  sidecarPlan?: SidecarPlan,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap) : [];
  const costColumn = costScope !== undefined ? costColumnFor(costScope.costMetric) : 'line_item_unblended_cost';
  const costTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const periods = resolveQueryPeriods(params.dateRange, availablePeriods);
  const source = buildSource(dataDir, costTier, dimensions, orgAccountsPath, periods, sidecarPlan, costColumn);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  if (params.orgNodeValues !== undefined && params.orgNodeValues.length > 0) {
    const escaped = params.orgNodeValues.map(v => `'${v.replaceAll("'", "''")}'`).join(', ');
    whereConditions.push(`${groupByResolved.fieldExpr} IN (${escaped})`);
  }

  return `
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
      LIMIT ${String(topN)}
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
}

export function buildTrendQuery(
  params: TrendQueryParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  sidecarPlan?: SidecarPlan,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap) : [];
  const costColumn = costScope !== undefined ? costColumnFor(costScope.costMetric) : 'line_item_unblended_cost';

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
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath, periods, sidecarPlan, costColumn);

  const allFilterClauses = [...filterClauses, ...exclusionClauses];
  const filterWhere = allFilterClauses.length > 0 ? ` AND ${allFilterClauses.join(' AND ')}` : '';

  return `
    WITH current_period AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        SUM(cost) AS total_cost
      FROM ${source}
      WHERE usage_date BETWEEN '${startDate}' AND '${endDate}'${filterWhere}
      GROUP BY entity
    ),
    period_length AS (
      SELECT DATEDIFF('day', DATE '${startDate}', DATE '${endDate}') + 1 AS days
    ),
    previous_period AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        SUM(cost) AS total_cost
      FROM ${source}
      WHERE usage_date BETWEEN
        DATE '${startDate}' - (SELECT days FROM period_length) * INTERVAL '1 day'
        AND DATE '${startDate}' - INTERVAL '1 day'${filterWhere}
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
    WHERE ABS(COALESCE(c.total_cost, 0) - COALESCE(p.total_cost, 0)) >= ${String(params.deltaThreshold)}
    ORDER BY ABS(COALESCE(c.total_cost, 0) - COALESCE(p.total_cost, 0)) DESC
  `.trim();
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
  sidecarPlan?: SidecarPlan,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
): string {
  const tagResolved = resolveField(params.tagDimension, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap) : [];
  const costColumn = costScope !== undefined ? costColumnFor(costScope.costMetric) : 'line_item_unblended_cost';
  const periods = resolveQueryPeriods(params.dateRange, availablePeriods);
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath, periods, sidecarPlan, costColumn);

  // Date + user filters apply to the resource aggregation.
  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    `line_item_type IN ('Usage', 'DiscountedUsage')`,
    `resource_id IS NOT NULL AND resource_id != ''`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  return `
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
      AND r.cost >= ${String(params.minCost)}
    ORDER BY r.cost DESC
  `.trim();
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
  sidecarPlan?: SidecarPlan,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
): string {
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap) : [];
  const costColumn = costScope !== undefined ? costColumnFor(costScope.costMetric) : 'line_item_unblended_cost';
  const periods = resolveQueryPeriods(params.dateRange, availablePeriods);
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath, periods, sidecarPlan, costColumn);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    `(line_item_type NOT IN ('Usage', 'DiscountedUsage') OR resource_id IS NULL OR resource_id = '')`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  return `
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
}

export function buildDailyCostsQuery(
  params: DailyCostsParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  sidecarPlan?: SidecarPlan,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap) : [];
  const costColumn = costScope !== undefined ? costColumnFor(costScope.costMetric) : 'line_item_unblended_cost';
  const dailyTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const periods = resolveQueryPeriods(params.dateRange, availablePeriods);
  const source = buildSource(dataDir, dailyTier, dimensions, orgAccountsPath, periods, sidecarPlan, costColumn);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    ...filterClauses,
    ...exclusionClauses,
  ];

  const dateExpr = dailyTier === 'hourly'
    ? "strftime(usage_hour, '%Y-%m-%d %H:00')"
    : 'usage_date::VARCHAR';

  return `
    SELECT
      ${dateExpr} AS date,
      ${groupByResolved.fieldExpr} AS group_name,
      SUM(cost) AS cost
    FROM ${source}
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY date, group_name
    ORDER BY date, cost DESC
  `.trim();
}

export function buildEntityDetailQuery(
  params: EntityDetailParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
  availablePeriods?: readonly string[],
  sidecarPlan?: SidecarPlan,
  accountReverseMap?: ReadonlyMap<string, readonly string[]>,
  costScope?: CostScopeConfig,
): string {
  const dimResolved = resolveField(params.dimension, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions, accountReverseMap);
  const exclusionClauses = costScope !== undefined ? buildExclusionClauses(costScope.rules, dimensions, accountReverseMap) : [];
  const costColumn = costScope !== undefined ? costColumnFor(costScope.costMetric) : 'line_item_unblended_cost';
  const granularity = params.granularity ?? 'daily';
  const tier = granularity === 'hourly' ? 'hourly' : 'daily';
  const periods = resolveQueryPeriods(params.dateRange, availablePeriods);
  const source = buildSource(dataDir, tier, dimensions, orgAccountsPath, periods, sidecarPlan, costColumn);

  // Same display-name collision treatment for the entity selector itself: if
  // the user clicked into "sre default" we need to match every underlying id,
  // not just one.
  const entityClause = (() => {
    if (dimResolved.rawField === 'account_id' && accountReverseMap !== undefined) {
      const ids = accountReverseMap.get(String(params.entity));
      if (ids !== undefined && ids.length > 0) {
        const list = ids.map(id => `'${id.replaceAll("'", "''")}'`).join(', ');
        return `${dimResolved.rawField} IN (${list})`;
      }
    }
    return `${dimResolved.fieldExpr} = '${String(params.entity).replaceAll("'", "''")}'`;
  })();

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    entityClause,
    ...filterClauses,
    ...exclusionClauses,
  ];

  // Group by hour for hourly tier so the entity detail histogram doesn't
  // collapse 24 hourly rows into one date row.
  const groupKey = tier === 'hourly'
    ? "strftime(usage_hour, '%Y-%m-%d %H:00')"
    : 'usage_date::VARCHAR';

  return `
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
}
