import type { DimensionsConfig } from '../types/config.js';
import type { CostQueryParams, FilterMap, TrendQueryParams, MissingTagsParams, EntityDetailParams } from '../types/query.js';
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
    clauses.push(`${resolved.fieldExpr} = '${String(value).replace(/'/g, "''")}'`);
  }
  return clauses;
}

export function buildCostQuery(
  params: CostQueryParams,
  dataDir: string,
  dimensions: DimensionsConfig,
  topN: number = 5,
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    ...filterClauses,
  ];

  if (params.orgNodeValues !== undefined && params.orgNodeValues.length > 0) {
    const escaped = params.orgNodeValues.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
    whereConditions.push(`${groupByResolved.fieldExpr} IN (${escaped})`);
  }

  return `
    WITH base AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        service,
        SUM(cost) AS cost
      FROM read_parquet('${dataDir}/aws/daily/**/data.parquet', hive_partitioning = true)
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
): string {
  const groupByResolved = resolveField(params.groupBy, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);

  const startDate = params.dateRange.start;
  const endDate = params.dateRange.end;

  const filterWhere = filterClauses.length > 0 ? ` AND ${filterClauses.join(' AND ')}` : '';

  return `
    WITH current_period AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        SUM(cost) AS total_cost
      FROM read_parquet('${dataDir}/aws/daily/**/data.parquet', hive_partitioning = true)
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
      FROM read_parquet('${dataDir}/aws/daily/**/data.parquet', hive_partitioning = true)
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
): string {
  const tagResolved = resolveField(params.tagDimension, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);

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
    FROM read_parquet('${dataDir}/aws/daily/**/data.parquet', hive_partitioning = true)
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY account_id, account_name, resource_id, service, service_family
    HAVING SUM(cost) >= ${String(params.minCost)}
    ORDER BY cost DESC
  `.trim();
}

export function buildEntityDetailQuery(
  params: EntityDetailParams,
  dataDir: string,
  dimensions: DimensionsConfig,
): string {
  const dimResolved = resolveField(params.dimension, dimensions);
  const filterClauses = buildFilterClauses(params.filters, dimensions);
  const granularity = params.granularity ?? 'daily';
  const tier = granularity === 'hourly' ? 'hourly' : 'daily';

  const whereConditions = [
    `usage_date BETWEEN '${params.dateRange.start}' AND '${params.dateRange.end}'`,
    `${dimResolved.fieldExpr} = '${String(params.entity).replace(/'/g, "''")}'`,
    ...filterClauses,
  ];

  return `
    SELECT
      usage_date,
      service,
      account_id,
      account_name,
      SUM(cost) AS cost
    FROM read_parquet('${dataDir}/aws/${tier}/**/data.parquet', hive_partitioning = true)
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY usage_date, service, account_id, account_name
    ORDER BY usage_date, cost DESC
  `.trim();
}
