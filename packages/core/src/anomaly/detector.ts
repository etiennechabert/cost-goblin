import type {
  Anomaly,
  AnomalyDailyCost,
  AnomalyDetailParams,
  AnomalyDetailResult,
  AnomalyDetectionParams,
  AnomalyResult,
  AnomalySeverity,
} from '../types/query.js';
import type { AnomalyId, DateString, DimensionId, EntityRef } from '../types/branded.js';
import { asAnomalyId, asDateString, asDollars, asEntityRef } from '../types/branded.js';
import type { ParameterizedQuery } from '../query/parameterized.js';
import {
  buildDateRangeWhere,
  resolveField,
  setupQuery,
  type DateRangeLike,
  type QueryContextOptions,
} from '../query/builder.js';

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Anomaly detection parameter "${name}" must be a non-negative finite number, got ${String(value)}`);
  }
}

/** Subtract `days` UTC days from `date` (YYYY-MM-DD) and return YYYY-MM-DD. */
function subtractDays(date: string, days: number): DateString {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return asDateString(d.toISOString().slice(0, 10));
}

function computeSeverity(deviations: number): AnomalySeverity {
  if (deviations >= 4) return 'high';
  if (deviations >= 3) return 'medium';
  return 'low';
}

function generateAnomalyId(entity: EntityRef, service: string, date: DateString): AnomalyId {
  return asAnomalyId(`${entity}-${service}-${date}`);
}

/**
 * Build the anomaly detection query.
 *
 * 1. Aggregates cost to (entity × service × date) using the configured groupBy
 *    dimension's resolved field expression (so aliases/normalize match the rest
 *    of the app), the user's filters, and any cost-scope exclusions.
 * 2. Computes a rolling baseline (avg + stddev) over `lookbackDays` immediately
 *    preceding each row, partitioned by (entity, service).
 * 3. Returns rows in the detection window where current cost exceeds
 *    `rolling_avg + stddevThreshold * stddev`, ordered by deviation.
 */
export function buildAnomalyDetectionQuery(
  params: AnomalyDetectionParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  assertFiniteNumber(params.lookbackDays, 'lookbackDays');
  assertFiniteNumber(params.stddevThreshold, 'stddevThreshold');

  const lookbackStart = subtractDays(params.dateRange.start, params.lookbackDays);
  const extendedRange: DateRangeLike = { start: lookbackStart, end: params.dateRange.end };

  const { qb, filterClauses, exclusionClauses, source } = setupQuery(
    { filters: params.filters, dateRange: extendedRange },
    'daily',
    opts,
  );
  const groupByResolved = resolveField(params.groupBy, opts.dimensions);

  const whereConditions = [
    buildDateRangeWhere(qb, extendedRange),
    ...filterClauses,
    ...exclusionClauses,
  ];

  const detectionStartParam = qb.addParam(params.dateRange.start);
  const lookbackDaysParam = qb.addParam(params.lookbackDays);
  const thresholdParam = qb.addParam(params.stddevThreshold);

  const sql = `
    WITH daily_costs AS (
      SELECT
        ${groupByResolved.fieldExpr} AS entity,
        service,
        usage_date AS date,
        SUM(cost) AS daily_cost
      FROM ${source}
      WHERE ${whereConditions.join(' AND ')}
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
      rolling_avg,
      stddev,
      (daily_cost - rolling_avg) / stddev AS deviation
    FROM stats
    WHERE date >= ${detectionStartParam}
      AND stddev > 0
      AND daily_cost > rolling_avg + (${thresholdParam} * stddev)
    ORDER BY deviation DESC, daily_cost DESC
  `.trim();

  return { sql, params: qb.build().params };
}

export interface AnomalyRow {
  readonly entity: string;
  readonly service: string;
  readonly detected_date: string;
  readonly current_cost: number;
  readonly rolling_avg: number;
  readonly stddev: number;
  readonly deviation: number;
}

/** Convert raw query rows into the typed AnomalyResult, dropping dismissed
 *  IDs and tallying severities. */
export function parseAnomalyDetectionResult(
  rows: readonly AnomalyRow[],
  dimension: DimensionId,
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
    if (dismissedIds.has(id)) continue;

    const severity = computeSeverity(row.deviation);
    const percentIncrease = row.rolling_avg > 0
      ? ((row.current_cost - row.rolling_avg) / row.rolling_avg) * 100
      : 0;

    anomalies.push({
      id,
      entity,
      dimension,
      service: row.service,
      detectedDate,
      currentCost: asDollars(row.current_cost),
      expectedCost: asDollars(row.rolling_avg),
      deviation: row.deviation,
      severity,
      percentIncrease,
      isDismissed: false,
    });

    switch (severity) {
      case 'high': highSeverityCount++; break;
      case 'medium': mediumSeverityCount++; break;
      case 'low': lowSeverityCount++; break;
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
 * Build the anomaly detail query: per-day cost time series for a single
 * (dimension, entity, service) over the lookback window ending on the detected
 * date, marking each day's `is_anomaly` against the same threshold the
 * detection used.
 */
export function buildAnomalyDetailQuery(
  params: AnomalyDetailParams,
  opts: QueryContextOptions,
): ParameterizedQuery {
  assertFiniteNumber(params.lookbackDays, 'lookbackDays');
  assertFiniteNumber(params.stddevThreshold, 'stddevThreshold');

  const lookbackStart = subtractDays(params.detectedDate, params.lookbackDays);
  const extendedRange: DateRangeLike = { start: lookbackStart, end: params.detectedDate };

  const { qb, exclusionClauses, source } = setupQuery(
    { filters: {}, dateRange: extendedRange },
    'daily',
    opts,
  );
  const dimResolved = resolveField(params.dimension, opts.dimensions);

  const dateWhere = buildDateRangeWhere(qb, extendedRange);
  const entityParam = qb.addParam(params.entity);
  const serviceParam = qb.addParam(params.service);
  const lookbackDaysParam = qb.addParam(params.lookbackDays);
  const thresholdParam = qb.addParam(params.stddevThreshold);

  const whereConditions = [
    dateWhere,
    `${dimResolved.fieldExpr} = ${entityParam}`,
    `service = ${serviceParam}`,
    ...exclusionClauses,
  ];

  const sql = `
    WITH daily_costs AS (
      SELECT
        usage_date AS date,
        SUM(cost) AS daily_cost
      FROM ${source}
      WHERE ${whereConditions.join(' AND ')}
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
      (stddev IS NOT NULL AND stddev > 0
        AND daily_cost > rolling_avg + (${thresholdParam} * stddev)) AS is_anomaly
    FROM stats
    ORDER BY date ASC
  `.trim();

  return { sql, params: qb.build().params };
}

export interface AnomalyDetailRow {
  readonly date: string;
  readonly daily_cost: number;
  readonly rolling_avg: number;
  readonly stddev: number;
  readonly is_anomaly: boolean;
}

export function parseAnomalyDetailResult(rows: readonly AnomalyDetailRow[]): AnomalyDetailResult {
  const dailyCosts: AnomalyDailyCost[] = rows.map(row => ({
    date: asDateString(row.date),
    cost: asDollars(row.daily_cost),
    isAnomaly: row.is_anomaly,
  }));

  // The last row's stats are the baseline as of the detected date — that's
  // what we surface to the user, not stale stats from earlier in the window.
  const lastRow = rows[rows.length - 1];
  const rollingAverage = lastRow !== undefined ? asDollars(lastRow.rolling_avg) : asDollars(0);
  const standardDeviation = lastRow !== undefined ? asDollars(lastRow.stddev) : asDollars(0);

  return { dailyCosts, rollingAverage, standardDeviation };
}
