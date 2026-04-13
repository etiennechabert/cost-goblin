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

  const dateExpr = tier === 'hourly'
    ? 'line_item_usage_start_date AS usage_date'
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

export function buildMissingTagsQuery(
  params: MissingTagsParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  orgAccountsPath?: string,
): string {
  const tagResolved = resolveField(params.tagDimension, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const source = buildSource(dataDir, 'daily', dimensions, orgAccountsPath);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    `(${tagResolved.rawField} IS NULL OR ${tagResolved.rawField} = '')`,
    ...filterClauses,
  ];

  return `
    SELECT
      account_id,
      account_name,
      resource_id,
      service,
      service_family,
      SUM(cost) AS cost
    FROM ${source}
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY account_id, account_name, resource_id, service, service_family
    HAVING SUM(cost) >= ${String(params.minCost)}
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
    ? "strftime(usage_date, '%Y-%m-%d %H:00')"
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

  return `
    SELECT
      usage_date,
      service,
      account_id,
      account_name,
      SUM(cost) AS cost
    FROM ${source}
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY usage_date, service, account_id, account_name
    ORDER BY usage_date, cost DESC
  `.trim();
}
