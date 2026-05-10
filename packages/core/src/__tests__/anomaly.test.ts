import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  buildAnomalyDetailQuery,
  buildAnomalyDetectionQuery,
  parseAnomalyDetailResult,
  parseAnomalyDetectionResult,
  type AnomalyDetailRow,
  type AnomalyRow,
} from '../anomaly/index.js';
import type { AnomalyDetailParams, AnomalyDetectionParams } from '../types/query.js';
import type { DimensionsConfig } from '../types/config.js';
import {
  asAnomalyId,
  asDateString,
  asDimensionId,
  asDollars,
  asEntityRef,
  asTagValue,
} from '../types/branded.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [
    { tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase', aliases: {} },
  ],
};

describe('parseAnomalyDetectionResult', () => {
  const baseRow = {
    entity: 'core-banking',
    service: 'EC2',
    detected_date: '2026-04-15',
    current_cost: 1000,
    rolling_avg: 500,
    stddev: 100,
    deviation: 5,
  };

  it('classifies severity by deviation thresholds (≥4 high, ≥3 medium, else low)', () => {
    const rows: AnomalyRow[] = [
      { ...baseRow, entity: 'a', deviation: 4.2 },
      { ...baseRow, entity: 'b', deviation: 3.5 },
      { ...baseRow, entity: 'c', deviation: 2.1 },
    ];
    const result = parseAnomalyDetectionResult(rows, asDimensionId('account'), new Set());
    expect(result.anomalies.map(a => a.severity)).toEqual(['high', 'medium', 'low']);
    expect(result.highSeverityCount).toBe(1);
    expect(result.mediumSeverityCount).toBe(1);
    expect(result.lowSeverityCount).toBe(1);
  });

  it('drops dismissed anomalies and excludes them from severity counts', () => {
    const rows: AnomalyRow[] = [
      { ...baseRow, entity: 'a', deviation: 5 },
      { ...baseRow, entity: 'b', deviation: 4 },
    ];
    const dismissed = new Set([asAnomalyId('a-EC2-2026-04-15')]);
    const result = parseAnomalyDetectionResult(rows, asDimensionId('account'), dismissed);
    expect(result.totalAnomalies).toBe(1);
    expect(result.anomalies[0]?.entity).toBe(asEntityRef('b'));
    expect(result.highSeverityCount).toBe(1);
  });

  it('treats zero baseline as 0% increase rather than dividing by zero', () => {
    const rows: AnomalyRow[] = [{ ...baseRow, rolling_avg: 0, deviation: 10 }];
    const result = parseAnomalyDetectionResult(rows, asDimensionId('account'), new Set());
    expect(result.anomalies[0]?.percentIncrease).toBe(0);
  });

  it('attaches the dimension param to every anomaly so the modal can issue a dimension-aware detail query', () => {
    const result = parseAnomalyDetectionResult([baseRow], asDimensionId('team'), new Set());
    expect(result.anomalies[0]?.dimension).toBe(asDimensionId('team'));
  });
});

describe('parseAnomalyDetailResult', () => {
  it('uses the LAST row as the canonical baseline (the one closest to detection)', () => {
    const rows: AnomalyDetailRow[] = [
      { date: '2026-04-01', daily_cost: 400, rolling_avg: 450, stddev: 50, is_anomaly: false },
      { date: '2026-04-15', daily_cost: 1000, rolling_avg: 500, stddev: 100, is_anomaly: true },
    ];
    const result = parseAnomalyDetailResult(rows);
    expect(result.rollingAverage).toBe(asDollars(500));
    expect(result.standardDeviation).toBe(asDollars(100));
    expect(result.dailyCosts).toHaveLength(2);
    expect(result.dailyCosts[1]?.isAnomaly).toBe(true);
  });

  it('returns zero stats when no rows came back from the query', () => {
    const result = parseAnomalyDetailResult([]);
    expect(result.dailyCosts).toEqual([]);
    expect(result.rollingAverage).toBe(asDollars(0));
    expect(result.standardDeviation).toBe(asDollars(0));
  });
});

describe('buildAnomalyDetectionQuery validation', () => {
  const valid: AnomalyDetectionParams = {
    groupBy: asDimensionId('account'),
    dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
    filters: {},
    lookbackDays: 30,
    stddevThreshold: 2,
  };

  it('rejects negative lookback', () => {
    expect(() => buildAnomalyDetectionQuery({ ...valid, lookbackDays: -1 }, { dataDir: '/d', dimensions }))
      .toThrow('lookbackDays');
  });

  it('rejects NaN threshold', () => {
    expect(() => buildAnomalyDetectionQuery({ ...valid, stddevThreshold: Number.NaN }, { dataDir: '/d', dimensions }))
      .toThrow('stddevThreshold');
  });

  it('rejects an unknown groupBy dimension (SecurityError, not silent SQL injection)', () => {
    expect(() =>
      buildAnomalyDetectionQuery(
        { ...valid, groupBy: asDimensionId('not_a_real_dim') },
        { dataDir: '/d', dimensions },
      ),
    ).toThrow(/Unknown dimension/);
  });
});

// Integration tests run the actual SQL against a DuckDB in-memory table via
// `materializedSource`, bypassing buildSource's parquet read. The substring
// tests this file used to have were a trap — they passed while the detail
// query had `WHERE account_id = $entity` for every dimension.
describe('anomaly detection — DuckDB integration', () => {
  let conn: DuckDBConnection;

  beforeAll(async () => {
    const inst = await DuckDBInstance.create();
    conn = await inst.connect();
    await conn.run(`
      CREATE TABLE cost_lines (
        usage_date DATE,
        account_id VARCHAR,
        service VARCHAR,
        tag_team VARCHAR,
        cost DOUBLE
      )
    `);
    const inserts: string[] = [];
    for (let i = 0; i < 60; i++) {
      const date = new Date(Date.UTC(2026, 1, 1 + i)).toISOString().slice(0, 10);
      // ml/EC2: ~$100/day with mild noise (so stddev > 0), $1000 spike on day 60 (2026-04-01).
      const mlNoise = ((i * 7) % 5) - 2; // -2..+2 deterministic
      const mlCost = i === 59 ? 1000 : 100 + mlNoise;
      inserts.push(`('${date}', '111', 'EC2', 'ml', ${String(mlCost)})`);
      // platform/RDS: ~$50/day with mild noise, no anomaly.
      const platNoise = ((i * 11) % 3) - 1; // -1..+1
      inserts.push(`('${date}', '222', 'RDS', 'platform', ${String(50 + platNoise)})`);
    }
    await conn.run(`INSERT INTO cost_lines VALUES ${inserts.join(',')}`);
  });

  async function runPrepared(sql: string, params: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    let substituted = sql;
    for (let i = params.length; i >= 1; i--) {
      const v = params[i - 1];
      const lit = typeof v === 'string' ? `'${v}'` : String(v);
      substituted = substituted.replaceAll(`$${String(i)}`, lit);
    }
    const result = await conn.run(substituted);
    const cols: string[] = [];
    for (let i = 0; i < result.columnCount; i++) cols.push(result.columnName(i));
    const out: Record<string, unknown>[] = [];
    let chunk = await result.fetchChunk();
    while (chunk !== null && chunk.rowCount > 0) {
      for (let r = 0; r < chunk.rowCount; r++) {
        const row: Record<string, unknown> = {};
        for (let c = 0; c < cols.length; c++) {
          const name = cols[c];
          if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
        }
        out.push(row);
      }
      chunk = await result.fetchChunk();
    }
    return out;
  }

  it('detects only the ml/EC2 spike when grouped by tag dimension, ignoring the stable series', async () => {
    const built = buildAnomalyDetectionQuery(
      {
        groupBy: asDimensionId('tag_team'),
        dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-01') },
        filters: {},
        lookbackDays: 30,
        stddevThreshold: 3,
      },
      { dataDir: '/unused', dimensions, materializedSource: 'cost_lines' },
    );
    const rows = await runPrepared(built.sql, built.params);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['entity']).toBe('ml');
    expect(rows[0]?.['service']).toBe('EC2');
    expect(Number(rows[0]?.['current_cost'])).toBe(1000);
  });

  it('respects user filters: a non-matching filter zeroes out the result', async () => {
    const built = buildAnomalyDetectionQuery(
      {
        groupBy: asDimensionId('tag_team'),
        dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-01') },
        filters: { [asDimensionId('service')]: [asTagValue('RDS')] },
        lookbackDays: 30,
        stddevThreshold: 3,
      },
      { dataDir: '/unused', dimensions, materializedSource: 'cost_lines' },
    );
    const rows = await runPrepared(built.sql, built.params);
    expect(rows).toHaveLength(0);
  });

  it('detail query targets the right column for tag-based dimensions (regression: previously hardcoded account_id)', async () => {
    const built = buildAnomalyDetailQuery(
      {
        anomalyId: asAnomalyId('ml-EC2-2026-04-01'),
        dimension: asDimensionId('tag_team'),
        entity: asEntityRef('ml'),
        service: 'EC2',
        detectedDate: asDateString('2026-04-01'),
        lookbackDays: 30,
        stddevThreshold: 3,
      } satisfies AnomalyDetailParams,
      { dataDir: '/unused', dimensions, materializedSource: 'cost_lines' },
    );
    const rows = await runPrepared(built.sql, built.params);
    // Lookback of 30 days from 2026-04-01 covers 2026-03-02 through 2026-04-01 inclusive = 31 rows.
    expect(rows.length).toBe(31);
    const lastRow = rows[rows.length - 1];
    expect(Number(lastRow?.['daily_cost'])).toBe(1000);
    expect(lastRow?.['is_anomaly']).toBe(true);
    const earlyAnomalies = rows.slice(0, -1).filter(r => r['is_anomaly'] === true);
    expect(earlyAnomalies).toHaveLength(0);
  });
});
