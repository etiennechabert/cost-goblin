import type {
  AnomalyDetectionParams,
  AnomalyResult,
  AnomalyDetailParams,
  AnomalyDetailResult,
  Anomaly,
  AnomalySeverity,
  AnomalyDailyCost,
} from '../types/query.js';
import type { AnomalyId, EntityRef, DateString } from '../types/branded.js';
import { asAnomalyId, asDollars, asEntityRef, asDateString } from '../types/branded.js';
import { QueryBuilder, type ParameterizedQuery } from '../query/parameterized.js';
import { buildSource, computePeriodsInRange } from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';

/** Resolve which periods to scan for the anomaly detection query. The detection
 *  window includes both the lookback period (for baseline calculation) and the
 *  detection window itself. */
function resolveAnomalyPeriods(
  params: AnomalyDetectionParams,
  availablePeriods: readonly string[] | undefined,
): string[] | undefined {
  if (availablePeriods === undefined) return undefined;

  // Compute the full range including lookback
  const lookbackStart = new Date(`${params.dateRange.start}T00:00:00Z`);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - params.lookbackDays);
  const lookbackStartStr = asDateString(lookbackStart.toISOString().split('T')[0] ?? '');

  const neededPeriods = computePeriodsInRange({
    start: lookbackStartStr,
    end: params.dateRange.end,
  });

  return neededPeriods.filter(p => availablePeriods.includes(p));
}

/** Compute anomaly severity based on standard deviation threshold. */
function computeSeverity(deviations: number): AnomalySeverity {
  if (deviations >= 4) return 'high';
  if (deviations >= 3) return 'medium';
  return 'low';
}

/** Generate a stable anomaly ID from entity, service, and date. */
function generateAnomalyId(entity: EntityRef, service: string, date: DateString): AnomalyId {
  return asAnomalyId(`${entity}-${service}-${date}`);
}

interface AnomalyRow {
  readonly entity: string;
  readonly service: string;
  readonly detected_date: string;
  readonly current_cost: number;
  readonly rolling_avg: number;
  readonly stddev: number;
  readonly deviation: number;
}

/** Assert that all required numeric fields are finite and valid. */
function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Anomaly detection parameter "${name}" must be a non-negative finite number, got ${String(value)}`);
  }
}

/**
 * Build the anomaly detection query. This query:
 * 1. Computes daily cost per (entity × service)
 * 2. Calculates rolling average and standard deviation over the lookback window
 * 3. Identifies days where cost > (avg + threshold * stddev)
 * 4. Filters to the detection window (excludes the lookback-only days)
 */
export function buildAnomalyDetectionQuery(
  params: AnomalyDetectionParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  assertFiniteNumber(params.lookbackDays, 'lookbackDays');
  assertFiniteNumber(params.stddevThreshold, 'stddevThreshold');

  const { dataDir, dimensions, orgAccountsPath, availablePeriods, availableColumns, costScope } = opts;
  const qb = new QueryBuilder();

  // Build the source with the extended date range to include lookback period
  const lookbackStart = new Date(`${params.dateRange.start}T00:00:00Z`);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - params.lookbackDays);
  const lookbackStartStr = asDateString(lookbackStart.toISOString().split('T')[0] ?? '');

  const periods = resolveAnomalyPeriods(params, availablePeriods);
  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';

  const source = buildSource({
    dataDir,
    tier: 'daily',
    dimensions,
    orgAccountsPath,
    periods,
    costMetric,
    availableColumns,
    costPerspective,
  });

  // Resolve the groupBy dimension field
  const groupByField = params.groupBy;

  // Build WHERE conditions
  const lookbackStartParam = qb.addParam(lookbackStartStr);
  const detectionEndParam = qb.addParam(params.dateRange.end);
  const detectionStartParam = qb.addParam(params.dateRange.start);
  const lookbackDaysParam = qb.addParam(params.lookbackDays);
  const thresholdParam = qb.addParam(params.stddevThreshold);

  const sql = `
    WITH daily_costs AS (
      SELECT
        ${groupByField} AS entity,
        service,
        usage_date AS date,
        SUM(cost) AS daily_cost
      FROM ${source}
      WHERE usage_date BETWEEN ${lookbackStartParam} AND ${detectionEndParam}
      GROUP BY entity, service, usage_date
    ),
    stats AS (
      SELECT
        entity,
        service,
        date,
        daily_cost,
        AVG(daily_cost) OVER (
          PARTITION BY entity, service
          ORDER BY date
          ROWS BETWEEN ${lookbackDaysParam} PRECEDING AND 1 PRECEDING
        ) AS rolling_avg,
        STDDEV(daily_cost) OVER (
          PARTITION BY entity, service
          ORDER BY date
          ROWS BETWEEN ${lookbackDaysParam} PRECEDING AND 1 PRECEDING
        ) AS stddev
      FROM daily_costs
    )
    SELECT
      entity,
      service,
      date AS detected_date,
      daily_cost AS current_cost,
      COALESCE(rolling_avg, 0) AS rolling_avg,
      COALESCE(stddev, 0) AS stddev,
      CASE
        WHEN stddev > 0 THEN (daily_cost - rolling_avg) / stddev
        ELSE 0
      END AS deviation
    FROM stats
    WHERE date >= ${detectionStartParam}
      AND stddev > 0
      AND daily_cost > rolling_avg + (${thresholdParam} * stddev)
    ORDER BY deviation DESC, daily_cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

/**
 * Parse the raw DuckDB result rows into the AnomalyResult structure.
 * Dismissed anomalies are filtered out by the caller (desktop layer has that state).
 */
export function parseAnomalyDetectionResult(
  rows: readonly AnomalyRow[],
  dimension: string,
  dismissedIds: ReadonlySet<AnomalyId>,
): AnomalyResult {
  const anomalies: Anomaly[] = [];
  let highSeverityCount = 0;
  let mediumSeverityCount = 0;
  let lowSeverityCount = 0;

  for (const row of rows) {
    const entity = asEntityRef(row.entity);
    const detectedDate = asDateString(row.detected_date);
    const id = generateAnomalyId(entity, row.service, detectedDate);

    // Skip dismissed anomalies
    if (dismissedIds.has(id)) {
      continue;
    }

    const currentCost = asDollars(row.current_cost);
    const expectedCost = asDollars(row.rolling_avg);
    const deviation = row.deviation;
    const severity = computeSeverity(deviation);
    const percentIncrease = row.rolling_avg > 0
      ? ((row.current_cost - row.rolling_avg) / row.rolling_avg) * 100
      : 0;

    anomalies.push({
      id,
      entity,
      dimension: dimension as never, // DimensionId from params
      service: row.service,
      detectedDate,
      currentCost,
      expectedCost,
      deviation,
      severity,
      percentIncrease,
      isDismissed: false,
    });

    // Count by severity
    switch (severity) {
      case 'high':
        highSeverityCount++;
        break;
      case 'medium':
        mediumSeverityCount++;
        break;
      case 'low':
        lowSeverityCount++;
        break;
    }
  }

  return {
    anomalies,
    totalAnomalies: anomalies.length,
    highSeverityCount,
    mediumSeverityCount,
    lowSeverityCount,
  };
}

/**
 * Build the anomaly detail query. This returns the full time series for the
 * affected (entity × service) combination, showing both normal and anomalous days.
 */
export function buildAnomalyDetailQuery(
  params: AnomalyDetailParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  assertFiniteNumber(params.lookbackDays, 'lookbackDays');

  const { dataDir, dimensions, orgAccountsPath, availablePeriods, availableColumns, costScope } = opts;
  const qb = new QueryBuilder();

  // Build the date range including lookback
  const lookbackStart = new Date(`${params.detectedDate}T00:00:00Z`);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - params.lookbackDays);
  const lookbackStartStr = asDateString(lookbackStart.toISOString().split('T')[0] ?? '');

  // Compute periods needed
  const neededPeriods = computePeriodsInRange({
    start: lookbackStartStr,
    end: params.detectedDate,
  });
  const periods = availablePeriods !== undefined
    ? neededPeriods.filter(p => availablePeriods.includes(p))
    : undefined;

  const costMetric = costScope?.costMetric ?? 'unblended';
  const costPerspective = costScope?.costPerspective ?? 'gross';

  const source = buildSource({
    dataDir,
    tier: 'daily',
    dimensions,
    orgAccountsPath,
    periods,
    costMetric,
    availableColumns,
    costPerspective,
  });

  // Parameters for the query
  const lookbackStartParam = qb.addParam(lookbackStartStr);
  const detectedDateParam = qb.addParam(params.detectedDate);
  const entityParam = qb.addParam(params.entity);
  const serviceParam = qb.addParam(params.service);
  const lookbackDaysParam = qb.addParam(params.lookbackDays);

  const sql = `
    WITH daily_costs AS (
      SELECT
        usage_date AS date,
        SUM(cost) AS daily_cost
      FROM ${source}
      WHERE usage_date BETWEEN ${lookbackStartParam} AND ${detectedDateParam}
        AND account_id = ${entityParam}
        AND service = ${serviceParam}
      GROUP BY usage_date
    ),
    stats AS (
      SELECT
        date,
        daily_cost,
        AVG(daily_cost) OVER (
          ORDER BY date
          ROWS BETWEEN ${lookbackDaysParam} PRECEDING AND 1 PRECEDING
        ) AS rolling_avg,
        STDDEV(daily_cost) OVER (
          ORDER BY date
          ROWS BETWEEN ${lookbackDaysParam} PRECEDING AND 1 PRECEDING
        ) AS stddev
      FROM daily_costs
    )
    SELECT
      date,
      daily_cost,
      COALESCE(rolling_avg, 0) AS rolling_avg,
      COALESCE(stddev, 0) AS stddev,
      CASE
        WHEN stddev > 0 AND daily_cost > rolling_avg + (2 * stddev) THEN true
        ELSE false
      END AS is_anomaly
    FROM stats
    ORDER BY date ASC
  `.trim();

  return { sql, params: qb.build().params };
}

interface AnomalyDetailRow {
  readonly date: string;
  readonly daily_cost: number;
  readonly rolling_avg: number;
  readonly stddev: number;
  readonly is_anomaly: boolean;
}

/**
 * Parse the anomaly detail result, including the time series and summary statistics.
 */
export function parseAnomalyDetailResult(
  rows: readonly AnomalyDetailRow[],
  anomaly: Anomaly,
): AnomalyDetailResult {
  const dailyCosts: AnomalyDailyCost[] = rows.map(row => ({
    date: asDateString(row.date),
    cost: asDollars(row.daily_cost),
    isAnomaly: row.is_anomaly,
  }));

  // Calculate final rolling average and stddev from the last row (the anomaly date)
  const lastRow = rows[rows.length - 1];
  const rollingAverage = lastRow !== undefined ? asDollars(lastRow.rolling_avg) : asDollars(0);
  const standardDeviation = lastRow !== undefined ? asDollars(lastRow.stddev) : asDollars(0);

  return {
    anomaly,
    dailyCosts,
    rollingAverage,
    standardDeviation,
    affectedResources: [], // TODO: Implement resource-level detail in a future iteration
  };
}
