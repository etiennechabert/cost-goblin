import { ipcMain } from 'electron';
import {
  asDollars,
  buildAnomalyDetailQuery,
  buildAnomalyDetectionQuery,
  logger,
  parseAnomalyDetailResult,
  parseAnomalyDetectionResult,
  type AnomalyDetailParams,
  type AnomalyDetailResult,
  type AnomalyDetailRow,
  type AnomalyDetectionParams,
  type AnomalyId,
  type AnomalyResult,
  type AnomalyRow,
  type QueryContextOptions,
} from '@costgoblin/core';
import type { RawRow } from '../duckdb-client.js';
import type { AppContext } from './context.js';
import { resolveAvailablePeriods, toNum, toStr } from './query-utils.js';

function toBool(v: unknown): boolean {
  return v === true;
}

function asAnomalyRows(rows: readonly RawRow[]): AnomalyRow[] {
  return rows.map(row => ({
    entity: toStr(row['entity']),
    service: toStr(row['service']),
    detected_date: toStr(row['detected_date']),
    current_cost: toNum(row['current_cost']),
    rolling_avg: toNum(row['rolling_avg']),
    stddev: toNum(row['stddev']),
    deviation: toNum(row['deviation']),
  }));
}

function asAnomalyDetailRows(rows: readonly RawRow[]): AnomalyDetailRow[] {
  return rows.map(row => ({
    date: toStr(row['date']),
    daily_cost: toNum(row['daily_cost']),
    rolling_avg: toNum(row['rolling_avg']),
    stddev: toNum(row['stddev']),
    is_anomaly: toBool(row['is_anomaly']),
  }));
}

function emptyAnomalyResult(): AnomalyResult {
  return {
    anomalies: [],
    totalAnomalies: 0,
    highSeverityCount: 0,
    mediumSeverityCount: 0,
    lowSeverityCount: 0,
  };
}

export function registerAnomalyHandlers(app: AppContext): void {
  const {
    ctx,
    getQueryDimensions,
    getAccountReverseMap,
    getOrgAccountsPath,
    getCostScope,
    getAvailableColumns,
    runPreparedQuery,
    materializedBase,
    getDismissedAnomalies,
    dismissAnomaly,
    restoreAnomaly,
  } = app;

  ipcMain.handle('query:anomalies', async (_event, params: AnomalyDetectionParams): Promise<AnomalyResult> => {
    const tier = 'daily';
    const [dimensions, accountReverseMap, orgPath, costScope, availableColumns, periodInfo] = await Promise.all([
      getQueryDimensions(),
      getAccountReverseMap(),
      getOrgAccountsPath(),
      getCostScope().catch(() => undefined),
      getAvailableColumns(tier),
      resolveAvailablePeriods(ctx.dataDir, tier, params.dateRange),
    ]);

    if (periodInfo.empty) return emptyAnomalyResult();

    const matSource = materializedBase.getSource(params.dateRange, tier);
    const isMat = matSource !== undefined;
    const qcOpts: QueryContextOptions = {
      dataDir: ctx.dataDir,
      dimensions,
      orgAccountsPath: orgPath,
      availablePeriods: periodInfo.available,
      accountReverseMap,
      costScope,
      availableColumns,
      materializedSource: matSource,
    };

    const { sql, params: queryParams } = buildAnomalyDetectionQuery(params, qcOpts);
    logger.info('query:anomalies', {
      groupBy: params.groupBy,
      lookbackDays: params.lookbackDays,
      stddevThreshold: params.stddevThreshold,
      materialized: isMat,
    });

    const rawRows = await runPreparedQuery(sql, queryParams, isMat);
    const dismissedSet = await getDismissedAnomalies();
    return parseAnomalyDetectionResult(asAnomalyRows(rawRows), params.groupBy, dismissedSet);
  });

  ipcMain.handle('query:anomaly-detail', async (_event, params: AnomalyDetailParams): Promise<AnomalyDetailResult> => {
    const tier = 'daily';
    const lookbackStart = new Date(`${params.detectedDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - params.lookbackDays);
    const dateRange = { start: lookbackStart.toISOString().slice(0, 10), end: params.detectedDate };

    const [dimensions, accountReverseMap, orgPath, costScope, availableColumns, periodInfo] = await Promise.all([
      getQueryDimensions(),
      getAccountReverseMap(),
      getOrgAccountsPath(),
      getCostScope().catch(() => undefined),
      getAvailableColumns(tier),
      resolveAvailablePeriods(ctx.dataDir, tier, dateRange),
    ]);

    if (periodInfo.empty) {
      return { dailyCosts: [], rollingAverage: asDollars(0), standardDeviation: asDollars(0) };
    }

    const matSource = materializedBase.getSource(dateRange, tier);
    const isMat = matSource !== undefined;
    const qcOpts: QueryContextOptions = {
      dataDir: ctx.dataDir,
      dimensions,
      orgAccountsPath: orgPath,
      availablePeriods: periodInfo.available,
      accountReverseMap,
      costScope,
      availableColumns,
      materializedSource: matSource,
    };

    const { sql, params: queryParams } = buildAnomalyDetailQuery(params, qcOpts);
    logger.info('query:anomaly-detail', {
      anomalyId: params.anomalyId,
      dimension: params.dimension,
      entity: params.entity,
      service: params.service,
      materialized: isMat,
    });

    const rawRows = await runPreparedQuery(sql, queryParams, isMat);
    return parseAnomalyDetailResult(asAnomalyDetailRows(rawRows));
  });

  ipcMain.handle('anomaly:dismiss', async (_event, anomalyId: AnomalyId): Promise<void> => {
    logger.info('anomaly:dismiss', { anomalyId });
    await dismissAnomaly(anomalyId);
  });

  ipcMain.handle('anomaly:restore', async (_event, anomalyId: AnomalyId): Promise<void> => {
    logger.info('anomaly:restore', { anomalyId });
    await restoreAnomaly(anomalyId);
  });
}
