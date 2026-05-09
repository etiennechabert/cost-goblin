import { describe, it, expect } from 'vitest';
import {
  buildAnomalyDetectionQuery,
  parseAnomalyDetectionResult,
  buildAnomalyDetailQuery,
  parseAnomalyDetailResult,
} from '../anomaly/detector.js';
import type { AnomalyDetectionParams, AnomalyDetailParams, Anomaly } from '../types/query.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asDateString, asEntityRef, asAnomalyId, asDollars } from '../types/branded.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [
    {
      tagName: 'org:team',
      label: 'Team',
      concept: 'owner',
      normalize: 'lowercase-kebab',
      aliases: {
        'core-banking': ['core_banking', 'corebanking'],
      },
    },
  ],
};

describe('buildAnomalyDetectionQuery', () => {
  const baseParams: AnomalyDetectionParams = {
    groupBy: asDimensionId('account'),
    dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
    filters: {},
    lookbackDays: 30,
    stddevThreshold: 2,
  };

  it('generates SQL with rolling average and standard deviation', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('daily_costs AS');
    expect(result.sql).toContain('stats AS');
    expect(result.sql).toContain('AVG(daily_cost) OVER');
    expect(result.sql).toContain('STDDEV(daily_cost) OVER');
    expect(result.sql).toContain('PARTITION BY entity, service');
  });

  it('uses lookback window for rolling statistics', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('ROWS BETWEEN');
    expect(result.sql).toContain('PRECEDING AND 1 PRECEDING');
    // Verify lookbackDays parameter is included
    expect(result.params).toContain(30);
  });

  it('filters to detection window (excludes lookback-only period)', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    // Query should filter WHERE date >= detection start
    expect(result.sql).toContain('WHERE date >=');
    // Verify both lookback start and detection start parameters
    expect(result.params).toContain('2026-04-01'); // detection start
    expect(result.params).toContain('2026-03-02'); // lookback start (30 days before)
    expect(result.params).toContain('2026-04-30'); // detection end
  });

  it('applies stddev threshold for anomaly detection', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('daily_cost > rolling_avg +');
    expect(result.sql).toContain('* stddev');
    expect(result.params).toContain(2); // stddevThreshold
  });

  it('computes deviation in standard deviations', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('(daily_cost - rolling_avg) / stddev');
    expect(result.sql).toContain('AS deviation');
    // Should handle division by zero
    expect(result.sql).toContain('CASE');
    expect(result.sql).toContain('WHEN stddev > 0');
  });

  it('orders results by deviation and cost', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('ORDER BY deviation DESC, daily_cost DESC');
  });

  it('uses correct groupBy field from dimension', () => {
    const result = buildAnomalyDetectionQuery(
      {
        ...baseParams,
        groupBy: asDimensionId('service'),
      },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).toContain('service AS entity');
  });

  it('includes periods covering both lookback and detection windows', () => {
    const availablePeriods = ['2026-03', '2026-04'];
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions, availablePeriods });
    // Should include both March (lookback) and April (detection) for a lookback starting March 2
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-03/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-04/*.parquet'");
  });

  it('validates numeric parameters are finite and non-negative', () => {
    expect(() =>
      buildAnomalyDetectionQuery(
        { ...baseParams, lookbackDays: -1 },
        { dataDir: '/data', dimensions },
      ),
    ).toThrow('lookbackDays');

    expect(() =>
      buildAnomalyDetectionQuery(
        { ...baseParams, stddevThreshold: Number.NaN },
        { dataDir: '/data', dimensions },
      ),
    ).toThrow('stddevThreshold');

    expect(() =>
      buildAnomalyDetectionQuery(
        { ...baseParams, lookbackDays: Number.POSITIVE_INFINITY },
        { dataDir: '/data', dimensions },
      ),
    ).toThrow('lookbackDays');
  });

  it('filters out rows where stddev is zero (prevents false positives)', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('AND stddev > 0');
  });

  it('uses parameterized queries (no direct value interpolation)', () => {
    const result = buildAnomalyDetectionQuery(baseParams, { dataDir: '/data', dimensions });
    // Should use $1, $2, etc. placeholders
    expect(result.sql).toContain('$');
    expect(result.sql).not.toContain('2026-04-01');
    expect(result.sql).not.toContain('30'); // numeric literals should be parameterized
    expect(result.params.length).toBeGreaterThan(0);
  });
});

describe('parseAnomalyDetectionResult', () => {
  it('parses rows into Anomaly objects', () => {
    const rows = [
      {
        entity: 'core-banking',
        service: 'EC2',
        detected_date: '2026-04-15',
        current_cost: 1000,
        rolling_avg: 500,
        stddev: 100,
        deviation: 5,
      },
    ];
    const result = parseAnomalyDetectionResult(rows, 'account', new Set());
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.entity).toBe(asEntityRef('core-banking'));
    expect(result.anomalies[0]?.service).toBe('EC2');
    expect(result.anomalies[0]?.detectedDate).toBe(asDateString('2026-04-15'));
    expect(result.anomalies[0]?.currentCost).toBe(asDollars(1000));
    expect(result.anomalies[0]?.expectedCost).toBe(asDollars(500));
  });

  it('computes severity based on deviation', () => {
    const rows = [
      // high severity (>= 4 stddev)
      {
        entity: 'team-a',
        service: 'S3',
        detected_date: '2026-04-15',
        current_cost: 1000,
        rolling_avg: 500,
        stddev: 100,
        deviation: 5,
      },
      // medium severity (>= 3, < 4 stddev)
      {
        entity: 'team-b',
        service: 'RDS',
        detected_date: '2026-04-15',
        current_cost: 800,
        rolling_avg: 500,
        stddev: 100,
        deviation: 3.5,
      },
      // low severity (>= 2, < 3 stddev)
      {
        entity: 'team-c',
        service: 'Lambda',
        detected_date: '2026-04-15',
        current_cost: 700,
        rolling_avg: 500,
        stddev: 100,
        deviation: 2.5,
      },
    ];
    const result = parseAnomalyDetectionResult(rows, 'account', new Set());
    expect(result.anomalies[0]?.severity).toBe('high');
    expect(result.anomalies[1]?.severity).toBe('medium');
    expect(result.anomalies[2]?.severity).toBe('low');
  });

  it('counts anomalies by severity', () => {
    const rows = [
      { entity: 'a', service: 'S3', detected_date: '2026-04-15', current_cost: 1000, rolling_avg: 500, stddev: 100, deviation: 5 },
      { entity: 'b', service: 'S3', detected_date: '2026-04-15', current_cost: 900, rolling_avg: 500, stddev: 100, deviation: 4.5 },
      { entity: 'c', service: 'RDS', detected_date: '2026-04-15', current_cost: 800, rolling_avg: 500, stddev: 100, deviation: 3.5 },
      { entity: 'd', service: 'Lambda', detected_date: '2026-04-15', current_cost: 700, rolling_avg: 500, stddev: 100, deviation: 2.5 },
    ];
    const result = parseAnomalyDetectionResult(rows, 'account', new Set());
    expect(result.highSeverityCount).toBe(2);
    expect(result.mediumSeverityCount).toBe(1);
    expect(result.lowSeverityCount).toBe(1);
    expect(result.totalAnomalies).toBe(4);
  });

  it('calculates percent increase correctly', () => {
    const rows = [
      {
        entity: 'team-a',
        service: 'EC2',
        detected_date: '2026-04-15',
        current_cost: 600,
        rolling_avg: 500,
        stddev: 50,
        deviation: 2,
      },
    ];
    const result = parseAnomalyDetectionResult(rows, 'account', new Set());
    // (600 - 500) / 500 * 100 = 20%
    expect(result.anomalies[0]?.percentIncrease).toBe(20);
  });

  it('handles zero baseline (avoids division by zero)', () => {
    const rows = [
      {
        entity: 'team-a',
        service: 'EC2',
        detected_date: '2026-04-15',
        current_cost: 100,
        rolling_avg: 0,
        stddev: 10,
        deviation: 10,
      },
    ];
    const result = parseAnomalyDetectionResult(rows, 'account', new Set());
    expect(result.anomalies[0]?.percentIncrease).toBe(0);
  });

  it('filters out dismissed anomalies', () => {
    const rows = [
      { entity: 'team-a', service: 'EC2', detected_date: '2026-04-15', current_cost: 1000, rolling_avg: 500, stddev: 100, deviation: 5 },
      { entity: 'team-b', service: 'S3', detected_date: '2026-04-15', current_cost: 900, rolling_avg: 500, stddev: 100, deviation: 4 },
    ];
    const dismissedIds = new Set([asAnomalyId('team-a-EC2-2026-04-15')]);
    const result = parseAnomalyDetectionResult(rows, 'account', dismissedIds);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.entity).toBe(asEntityRef('team-b'));
    expect(result.totalAnomalies).toBe(1);
  });

  it('generates stable anomaly IDs from entity, service, and date', () => {
    const rows = [
      {
        entity: 'core-banking',
        service: 'EC2',
        detected_date: '2026-04-15',
        current_cost: 1000,
        rolling_avg: 500,
        stddev: 100,
        deviation: 5,
      },
    ];
    const result = parseAnomalyDetectionResult(rows, 'account', new Set());
    expect(result.anomalies[0]?.id).toBe(asAnomalyId('core-banking-EC2-2026-04-15'));
  });

  it('marks all anomalies as not dismissed in result', () => {
    const rows = [
      { entity: 'team-a', service: 'EC2', detected_date: '2026-04-15', current_cost: 1000, rolling_avg: 500, stddev: 100, deviation: 5 },
    ];
    const result = parseAnomalyDetectionResult(rows, 'account', new Set());
    expect(result.anomalies[0]?.isDismissed).toBe(false);
  });

  it('handles empty result set', () => {
    const result = parseAnomalyDetectionResult([], 'account', new Set());
    expect(result.anomalies).toHaveLength(0);
    expect(result.totalAnomalies).toBe(0);
    expect(result.highSeverityCount).toBe(0);
    expect(result.mediumSeverityCount).toBe(0);
    expect(result.lowSeverityCount).toBe(0);
  });

  it('dismissed anomalies do not affect severity counts', () => {
    const rows = [
      { entity: 'a', service: 'EC2', detected_date: '2026-04-15', current_cost: 1000, rolling_avg: 500, stddev: 100, deviation: 5 },
      { entity: 'b', service: 'S3', detected_date: '2026-04-15', current_cost: 900, rolling_avg: 500, stddev: 100, deviation: 4 },
    ];
    const dismissedIds = new Set([asAnomalyId('a-EC2-2026-04-15')]);
    const result = parseAnomalyDetectionResult(rows, 'account', dismissedIds);
    // Only one anomaly should be counted
    expect(result.totalAnomalies).toBe(1);
    expect(result.highSeverityCount).toBe(1);
  });
});

describe('buildAnomalyDetailQuery', () => {
  const baseParams: AnomalyDetailParams = {
    anomalyId: asAnomalyId('core-banking-EC2-2026-04-15'),
    entity: asEntityRef('111111111111'),
    service: 'EC2',
    detectedDate: asDateString('2026-04-15'),
    lookbackDays: 30,
  };

  it('generates SQL for time series with rolling statistics', () => {
    const result = buildAnomalyDetailQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('daily_costs AS');
    expect(result.sql).toContain('stats AS');
    expect(result.sql).toContain('AVG(daily_cost) OVER');
    expect(result.sql).toContain('STDDEV(daily_cost) OVER');
  });

  it('filters to specific entity and service', () => {
    const result = buildAnomalyDetailQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('account_id =');
    expect(result.sql).toContain('service =');
    expect(result.params).toContain('111111111111');
    expect(result.params).toContain('EC2');
  });

  it('includes lookback period from detected date', () => {
    const result = buildAnomalyDetailQuery(baseParams, { dataDir: '/data', dimensions });
    // 30 days before 2026-04-15 is 2026-03-16
    expect(result.params).toContain('2026-03-16'); // lookback start
    expect(result.params).toContain('2026-04-15'); // detected date
  });

  it('marks anomaly days with is_anomaly flag', () => {
    const result = buildAnomalyDetailQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('WHEN stddev > 0 AND daily_cost > rolling_avg + (2 * stddev)');
    expect(result.sql).toContain('AS is_anomaly');
  });

  it('orders results chronologically', () => {
    const result = buildAnomalyDetailQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('ORDER BY date ASC');
  });

  it('validates lookbackDays is finite and non-negative', () => {
    expect(() =>
      buildAnomalyDetailQuery(
        { ...baseParams, lookbackDays: -1 },
        { dataDir: '/data', dimensions },
      ),
    ).toThrow('lookbackDays');

    expect(() =>
      buildAnomalyDetailQuery(
        { ...baseParams, lookbackDays: Number.NaN },
        { dataDir: '/data', dimensions },
      ),
    ).toThrow('lookbackDays');
  });

  it('uses parameterized queries', () => {
    const result = buildAnomalyDetailQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain('$');
    expect(result.sql).not.toContain('111111111111');
    expect(result.sql).not.toContain('EC2');
    expect(result.params.length).toBeGreaterThan(0);
  });

  it('includes required periods from lookback to detected date', () => {
    const availablePeriods = ['2026-03', '2026-04'];
    const result = buildAnomalyDetailQuery(baseParams, { dataDir: '/data', dimensions, availablePeriods });
    // Should include both March and April
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-03/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-04/*.parquet'");
  });
});

describe('parseAnomalyDetailResult', () => {
  const mockAnomaly: Anomaly = {
    id: asAnomalyId('core-banking-EC2-2026-04-15'),
    entity: asEntityRef('core-banking'),
    dimension: asDimensionId('account'),
    service: 'EC2',
    detectedDate: asDateString('2026-04-15'),
    currentCost: asDollars(1000),
    expectedCost: asDollars(500),
    deviation: 5,
    severity: 'high',
    percentIncrease: 100,
    isDismissed: false,
  };

  it('parses daily cost time series', () => {
    const rows = [
      { date: '2026-04-01', daily_cost: 400, rolling_avg: 450, stddev: 50, is_anomaly: false },
      { date: '2026-04-02', daily_cost: 450, rolling_avg: 460, stddev: 55, is_anomaly: false },
      { date: '2026-04-15', daily_cost: 1000, rolling_avg: 500, stddev: 100, is_anomaly: true },
    ];
    const result = parseAnomalyDetailResult(rows, mockAnomaly);
    expect(result.dailyCosts).toHaveLength(3);
    expect(result.dailyCosts[0]?.date).toBe(asDateString('2026-04-01'));
    expect(result.dailyCosts[0]?.cost).toBe(asDollars(400));
    expect(result.dailyCosts[0]?.isAnomaly).toBe(false);
    expect(result.dailyCosts[2]?.isAnomaly).toBe(true);
  });

  it('extracts final rolling average and stddev from last row', () => {
    const rows = [
      { date: '2026-04-01', daily_cost: 400, rolling_avg: 450, stddev: 50, is_anomaly: false },
      { date: '2026-04-15', daily_cost: 1000, rolling_avg: 500, stddev: 100, is_anomaly: true },
    ];
    const result = parseAnomalyDetailResult(rows, mockAnomaly);
    expect(result.rollingAverage).toBe(asDollars(500));
    expect(result.standardDeviation).toBe(asDollars(100));
  });

  it('includes the anomaly object in result', () => {
    const rows = [
      { date: '2026-04-15', daily_cost: 1000, rolling_avg: 500, stddev: 100, is_anomaly: true },
    ];
    const result = parseAnomalyDetailResult(rows, mockAnomaly);
    expect(result.anomaly).toBe(mockAnomaly);
  });

  it('handles empty result (returns zero stats)', () => {
    const result = parseAnomalyDetailResult([], mockAnomaly);
    expect(result.dailyCosts).toHaveLength(0);
    expect(result.rollingAverage).toBe(asDollars(0));
    expect(result.standardDeviation).toBe(asDollars(0));
  });

  it('initializes affectedResources as empty array (future feature)', () => {
    const rows = [
      { date: '2026-04-15', daily_cost: 1000, rolling_avg: 500, stddev: 100, is_anomaly: true },
    ];
    const result = parseAnomalyDetailResult(rows, mockAnomaly);
    expect(result.affectedResources).toEqual([]);
  });
});

describe('anomaly detection edge cases', () => {
  it('handles year boundary in lookback period', () => {
    const params: AnomalyDetectionParams = {
      groupBy: asDimensionId('account'),
      dateRange: { start: asDateString('2026-01-15'), end: asDateString('2026-01-31') },
      filters: {},
      lookbackDays: 30,
      stddevThreshold: 2,
    };
    const availablePeriods = ['2025-12', '2026-01'];
    const result = buildAnomalyDetectionQuery(params, { dataDir: '/data', dimensions, availablePeriods });
    // Lookback should include December 2025
    expect(result.sql).toContain("'/data/aws/raw/daily-2025-12/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-01/*.parquet'");
  });

  it('handles single-day detection window', () => {
    const params: AnomalyDetectionParams = {
      groupBy: asDimensionId('account'),
      dateRange: { start: asDateString('2026-04-15'), end: asDateString('2026-04-15') },
      filters: {},
      lookbackDays: 30,
      stddevThreshold: 2,
    };
    const result = buildAnomalyDetectionQuery(params, { dataDir: '/data', dimensions });
    expect(result.params).toContain('2026-04-15');
    expect(result.sql).toContain('WHERE date >=');
  });

  it('handles large lookback period spanning multiple months', () => {
    const params: AnomalyDetectionParams = {
      groupBy: asDimensionId('account'),
      dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
      filters: {},
      lookbackDays: 90,
      stddevThreshold: 2,
    };
    const availablePeriods = ['2026-01', '2026-02', '2026-03', '2026-04'];
    const result = buildAnomalyDetectionQuery(params, { dataDir: '/data', dimensions, availablePeriods });
    // 90 days before 2026-04-01 is 2026-01-01
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-01/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-02/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-03/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-04/*.parquet'");
  });

  it('handles high stddev threshold (fewer anomalies)', () => {
    const params: AnomalyDetectionParams = {
      groupBy: asDimensionId('account'),
      dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
      filters: {},
      lookbackDays: 30,
      stddevThreshold: 5,
    };
    const result = buildAnomalyDetectionQuery(params, { dataDir: '/data', dimensions });
    expect(result.params).toContain(5);
  });

  it('handles low stddev threshold (more anomalies)', () => {
    const params: AnomalyDetectionParams = {
      groupBy: asDimensionId('account'),
      dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
      filters: {},
      lookbackDays: 30,
      stddevThreshold: 1.5,
    };
    const result = buildAnomalyDetectionQuery(params, { dataDir: '/data', dimensions });
    expect(result.params).toContain(1.5);
  });
});
