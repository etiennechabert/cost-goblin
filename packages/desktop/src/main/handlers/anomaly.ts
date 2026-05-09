import { ipcMain } from 'electron';
import {
  buildAnomalyDetectionQuery,
  buildAnomalyDetailQuery,
  parseAnomalyDetectionResult,
  parseAnomalyDetailResult,
  logger,
  asDollars,
} from '@costgoblin/core';
import type {
  AnomalyDetectionParams,
  AnomalyResult,
  AnomalyDetailParams,
  AnomalyDetailResult,
  AnomalyId,
  Anomaly,
  QueryContextOptions,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import { resolveAvailablePeriods } from './query-utils.js';

export function registerAnomalyHandlers(app: AppContext): void {
  const {
    ctx,
    getQueryDimensions: getDimensions,
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
    const dimensions = await getDimensions();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = 'daily';
    const availableColumns = await getAvailableColumns(tier);
    const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, tier, params.dateRange);

    if (empty) {
      return {
        anomalies: [],
        totalAnomalies: 0,
        highSeverityCount: 0,
        mediumSeverityCount: 0,
        lowSeverityCount: 0,
      };
    }

    const matSource = materializedBase.getSource(params.dateRange, tier);
    const isMat = matSource !== undefined;
    const qcOpts: QueryContextOptions = {
      dataDir: ctx.dataDir,
      dimensions,
      orgAccountsPath: orgPath,
      availablePeriods: available,
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

    const rows = await runPreparedQuery(sql, queryParams, isMat);
    const dismissedSet = await getDismissedAnomalies();

    // Type assertion: rows from DuckDB match the expected AnomalyRow structure
    type AnomalyRow = {
      readonly entity: string;
      readonly service: string;
      readonly detected_date: string;
      readonly current_cost: number;
      readonly rolling_avg: number;
      readonly stddev: number;
      readonly deviation: number;
    };

    return parseAnomalyDetectionResult(rows as unknown as readonly AnomalyRow[], params.groupBy, dismissedSet);
  });

  ipcMain.handle('query:anomaly-detail', async (_event, params: AnomalyDetailParams): Promise<AnomalyDetailResult> => {
    const dimensions = await getDimensions();
    const accountReverseMap = await getAccountReverseMap();
    const orgPath = await getOrgAccountsPath();
    const costScope = await getCostScope().catch(() => undefined);
    const tier = 'daily';
    const availableColumns = await getAvailableColumns(tier);

    // Build date range from detected date and lookback
    const lookbackStart = new Date(`${params.detectedDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - params.lookbackDays);
    const dateRange = {
      start: lookbackStart.toISOString().slice(0, 10),
      end: params.detectedDate,
    };

    const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, tier, dateRange);

    // Create a basic Anomaly object for empty case
    const emptyAnomaly: Anomaly = {
      id: params.anomalyId,
      entity: params.entity,
      dimension: 'account' as import('@costgoblin/core').DimensionId,
      service: params.service,
      detectedDate: params.detectedDate,
      currentCost: asDollars(0),
      expectedCost: asDollars(0),
      deviation: 0,
      severity: 'low',
      percentIncrease: 0,
      isDismissed: false,
    };

    if (empty) {
      return {
        anomaly: emptyAnomaly,
        dailyCosts: [],
        rollingAverage: asDollars(0),
        standardDeviation: asDollars(0),
        affectedResources: [],
      };
    }

    const matSource = materializedBase.getSource(dateRange, tier);
    const isMat = matSource !== undefined;
    const qcOpts: QueryContextOptions = {
      dataDir: ctx.dataDir,
      dimensions,
      orgAccountsPath: orgPath,
      availablePeriods: available,
      accountReverseMap,
      costScope,
      availableColumns,
      materializedSource: matSource,
    };

    const { sql, params: queryParams } = buildAnomalyDetailQuery(params, qcOpts);
    logger.info('query:anomaly-detail', {
      anomalyId: params.anomalyId,
      entity: params.entity,
      service: params.service,
      materialized: isMat,
    });

    const rows = await runPreparedQuery(sql, queryParams, isMat);

    // Type assertion: rows from DuckDB match the expected AnomalyDetailRow structure
    type AnomalyDetailRow = {
      readonly date: string;
      readonly daily_cost: number;
      readonly rolling_avg: number;
      readonly stddev: number;
      readonly is_anomaly: boolean;
    };

    // For the real query, we need to reconstruct the anomaly from the detail params
    // In a real scenario, this would come from querying the anomaly first, but for now
    // we create a basic one - the parse function will use whatever anomaly we pass
    return parseAnomalyDetailResult(rows as unknown as readonly AnomalyDetailRow[], emptyAnomaly);
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
