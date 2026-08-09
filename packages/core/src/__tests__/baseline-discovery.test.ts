import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBaselineDiscoveryQuery, buildBaselineTotalsQuery, buildDimCardinalityQuery, buildSource } from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDateString, asDimensionId, asProviderName } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const PROVIDER = asProviderName(FIXTURE_PROVIDER_NAME);
const PERIODS = ['2026-01', '2026-02'];

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
  ],
  tags: [],
};

const costScope: CostScopeConfig = { costMetric: 'effective', rules: [] };
const opts: QueryContextOptions = { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, availablePeriods: PERIODS }], costScope };
const dateRange = { start: asDateString('2026-01-01'), end: asDateString('2026-02-28') };

interface Row { [k: string]: unknown }

function substituteParams(sql: string, params: readonly unknown[]): string {
  let out = sql;
  for (let i = params.length; i >= 1; i--) {
    const param = params[i - 1];
    const value = typeof param === 'string' ? `'${param}'` : String(param);
    out = out.replaceAll('$' + String(i), value);
  }
  return out;
}

describe('baseline discovery query (DuckDB)', () => {
  let conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

  async function queryAll(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const result = await conn.run(substituteParams(sql, params));
    const cols = result.columnCount;
    const names: string[] = [];
    for (let i = 0; i < cols; i++) names.push(result.columnName(i));
    const rows: Row[] = [];
    let chunk = await result.fetchChunk();
    while (chunk !== null && chunk.rowCount > 0) {
      for (let r = 0; r < chunk.rowCount; r++) {
        const row: Row = {};
        for (let c = 0; c < cols; c++) {
          const name = names[c];
          if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
        }
        rows.push(row);
      }
      chunk = await result.fetchChunk();
    }
    return rows;
  }

  beforeAll(async () => {
    const db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  it('enumerates (account_id, service) tuples and sums losslessly vs raw', async () => {
    const q = buildBaselineDiscoveryQuery(
      { dateRange, filters: {}, grainDimensionIds: [asDimensionId('account_id'), asDimensionId('service')], minTotalCost: 0 },
      opts,
    );
    const rows = await queryAll(q.sql, q.params);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('account_id');
    expect(rows[0]).toHaveProperty('service');
    expect(rows[0]).toHaveProperty('date');
    expect(rows[0]).toHaveProperty('cost');

    const discoveryTotal = rows.reduce((acc, r) => acc + Number(r['cost']), 0);

    const src = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [{ name: PROVIDER, periods: PERIODS }], costMetric: 'effective' });
    // Reference: sum/count over per-tuple totals that clear the same >= 0 floor,
    // so the per-day decomposition is verified lossless.
    const [rawTotalRow] = await queryAll(
      `SELECT SUM(c) AS t, COUNT(*) AS n FROM (SELECT account_id, service, SUM(cost) AS c FROM ${src} WHERE usage_date BETWEEN '2026-01-01' AND '2026-02-28' GROUP BY account_id, service HAVING SUM(cost) >= 0)`,
    );
    expect(discoveryTotal).toBeCloseTo(Number(rawTotalRow?.['t']), 2);

    const tuples = new Set(rows.map((r) => `${String(r['account_id'])}|${String(r['service'])}`));
    expect(tuples.size).toBe(Number(rawTotalRow?.['n']));
  });

  it('min-total threshold drops low-value tuples', async () => {
    const all = buildBaselineDiscoveryQuery(
      { dateRange, filters: {}, grainDimensionIds: [asDimensionId('account_id'), asDimensionId('service')], minTotalCost: 0 },
      opts,
    );
    const allRows = await queryAll(all.sql, all.params);
    const allTuples = new Set(allRows.map((r) => `${String(r['account_id'])}|${String(r['service'])}`));

    const filtered = buildBaselineDiscoveryQuery(
      { dateRange, filters: {}, grainDimensionIds: [asDimensionId('account_id'), asDimensionId('service')], minTotalCost: 100000 },
      opts,
    );
    const filteredRows = await queryAll(filtered.sql, filtered.params);
    const filteredTuples = new Set(filteredRows.map((r) => `${String(r['account_id'])}|${String(r['service'])}`));

    expect(filteredTuples.size).toBeLessThan(allTuples.size);
  });

  it('totals query returns one row per tuple with the correct total', async () => {
    const q = buildBaselineTotalsQuery(
      { dateRange, filters: {}, grainDimensionIds: [asDimensionId('account_id'), asDimensionId('service')] },
      opts,
    );
    const rows = await queryAll(q.sql, q.params);
    const src = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [{ name: PROVIDER, periods: PERIODS }], costMetric: 'effective' });
    const [ref] = await queryAll(
      `SELECT COUNT(*) AS n, SUM(c) AS t FROM (SELECT account_id, service, SUM(cost) AS c FROM ${src} WHERE usage_date BETWEEN '2026-01-01' AND '2026-02-28' GROUP BY account_id, service)`,
    );
    expect(rows).toHaveLength(Number(ref?.['n']));
    const totalSum = rows.reduce((acc, r) => acc + Number(r['total']), 0);
    expect(totalSum).toBeCloseTo(Number(ref?.['t']), 2);
    // one row per tuple — not a per-day fan-out
    const keys = new Set(rows.map((r) => `${String(r['account_id'])}|${String(r['service'])}`));
    expect(keys.size).toBe(rows.length);
  });

  it('cardinality probe returns per-column distinct counts', async () => {
    const q = buildDimCardinalityQuery(['account_id', 'service', 'region'], dateRange, opts);
    const [row] = await queryAll(q.sql, q.params);
    expect(Number(row?.['account_id'])).toBeGreaterThan(0);
    expect(Number(row?.['service'])).toBeGreaterThan(0);
    expect(Number(row?.['region'])).toBeGreaterThan(0);
    expect(Number(row?.['row_count'])).toBeGreaterThan(0);
  });
});
