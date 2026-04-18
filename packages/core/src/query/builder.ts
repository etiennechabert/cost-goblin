import type { DimensionsConfig } from '../types/config.js';
import type { CostQueryParams, DailyCostsParams, FilterMap, TrendQueryParams, MissingTagsParams, EntityDetailParams } from '../types/query.js';
import type { DimensionId } from '../types/branded.js';
import { buildAliasSqlCase } from '../normalize/normalize.js';

interface ResolvedDimension {
  readonly fieldExpr: string;
  readonly rawField: string;
}

function resolveField(dimensionId: DimensionId, dimensions: DimensionsConfig): ResolvedDimension {
  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  if (builtIn !== undefined) {
    return { fieldExpr: builtIn.field, rawField: builtIn.field };
  }

  const tag = dimensions.tags.find(d => `tag_${d.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === dimensionId);
  if (tag !== undefined) {
    const rawField = `tag_${tag.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return { fieldExpr: buildAliasSqlCase(rawField, tag), rawField };
  }

  return { fieldExpr: dimensionId, rawField: dimensionId };
}

function buildFilterClauses(filters: FilterMap, dimensions: DimensionsConfig): string[] {
  const clauses: string[] = [];
  for (const [dimId, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    const resolved = resolveField(dimId as DimensionId, dimensions);
    clauses.push(`${resolved.fieldExpr} = '${String(value).replaceAll("'", "''")}'`);
  }
  return clauses;
}

export function buildSource(dataDir: string, tier: string, dimensions: DimensionsConfig, orgAccountsPath?: string): string {
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

  const parquetSource = `read_parquet('${dataDir}/aws/raw/${tier}-*/*.parquet')`;

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
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_unblended_cost, 0) AS cost,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}pricing_public_on_demand_cost, 0) AS list_cost,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_line_item_type, '') AS line_item_type,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_operation, '') AS operation,
      COALESCE(${needsOrgJoin ? 'cur.' : ''}line_item_usage_type, '') AS usage_type${tagClause}
    FROM ${fromClause}
  )`;
}

export function buildCostQuery(
  params: CostQueryParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  topN: number = 5,
  orgAccountsPath?: string,
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const costTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const source = buildSource(dataDir, costTier, dimensions, orgAccountsPath);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    ...filterClauses,
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
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath);

  const startDate = params.dateRange.start;
  const endDate = params.dateRange.end;

  const filterWhere = filterClauses.length > 0 ? ` AND ${filterClauses.join(' AND ')}` : '';

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
): string {
  const tagResolved = resolveField(params.tagDimension, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath);

  // Date + user filters apply to the resource aggregation.
  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    `line_item_type IN ('Usage', 'DiscountedUsage')`,
    `resource_id IS NOT NULL AND resource_id != ''`,
    ...filterClauses,
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
): string {
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    `(line_item_type NOT IN ('Usage', 'DiscountedUsage') OR resource_id IS NULL OR resource_id = '')`,
    ...filterClauses,
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
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const dailyTier = params.granularity === 'hourly' ? 'hourly' : 'daily';
  const source = buildSource(dataDir, dailyTier, dimensions, orgAccountsPath);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    ...filterClauses,
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
): string {
  const dimResolved = resolveField(params.dimension, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const granularity = params.granularity ?? 'daily';
  const tier = granularity === 'hourly' ? 'hourly' : 'daily';
  const source = buildSource(dataDir, tier, dimensions, orgAccountsPath);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    `${dimResolved.fieldExpr} = '${String(params.entity).replaceAll("'", "''")}'`,
    ...filterClauses,
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
