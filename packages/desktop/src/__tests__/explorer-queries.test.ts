import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  asDateString,
  asDimensionId,
  asHourString,
  asProviderName,
  buildRollupPartitionQuery,
  rollupGrainColumns,
  sqlStringLiteral,
  type CostScopeConfig,
  type ExplorerBaseParams,
} from '@costgoblin/core';
import {
  queryAggregatedTable,
  queryExplorerFilterValues,
  queryExplorerOverview,
  queryExplorerRows,
  type ExplorerDeps,
} from '../main/handlers/explorer-queries.js';
import { RollupStore } from '../main/rollup-store.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import {
  FIXTURE_DIMENSIONS,
  FIXTURE_NOW,
  FIXTURE_PROVIDERS,
  RAW_FIXTURE,
  SYNTHETIC_DIR,
  fixtureAccountMaps,
} from './helpers/synthetic-handlers.js';

// #479: the Explorer's queries bind every value as a parameter. These run each
// handler body against real DuckDB, so a query handed the wrong value list
// ("Can not bind to parameter number N") or a value that no longer binds fails
// here rather than only in e2e.

const RANGE = { start: asDateString('2026-01-20'), end: asDateString('2026-02-18') };
const base: ExplorerBaseParams = { filters: {}, dateRange: RANGE };
const identityRule = {
  id: 'identity', name: 'identity', enabled: true, builtIn: false,
  conditions: [{ dimensionId: asDimensionId('tag_team'), values: ['identity'] }],
};
const RAW_HOURLY_GLOB = `${SYNTHETIC_DIR}/aws-main/raw/hourly-*/*.parquet`;
const RAW_HOURLY = `read_parquet(${sqlStringLiteral(RAW_HOURLY_GLOB)}, union_by_name=true)`;

describe('Explorer queries (DuckDB over the synthetic fixtures)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let rollupDir: string;
  let deps: ExplorerDeps;
  let scope: CostScopeConfig = { costMetric: 'billed', rules: [] };
  const materializedFlags: boolean[] = [];

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    rollupDir = mkdtempSync(join(tmpdir(), 'cg-explorer-'));
    const { accountMap, accountReverseMap } = await fixtureAccountMaps(conn);
    deps = {
      dataDir: SYNTHETIC_DIR,
      now: FIXTURE_NOW,
      getCostScope: () => Promise.resolve(scope),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      getQueryDimensions: () => Promise.resolve(FIXTURE_DIMENSIONS),
      getAccountMap: () => Promise.resolve(accountMap),
      getAccountReverseMap: () => Promise.resolve(accountReverseMap),
      getQueryProviders: (tier) => Promise.resolve(tier === 'hourly'
        ? [{ name: asProviderName('aws-main'), availablePeriods: ['2026-02'] }]
        : FIXTURE_PROVIDERS),
      runPreparedQuery: (sql, params, materialized) => {
        materializedFlags.push(materialized === true);
        return fetchRowsPrepared(conn, sql, params);
      },
      // Never loaded, so the overview reads raw unless a test swaps in a built store.
      rollupStore: new RollupStore({ dataDir: rollupDir, providerName: () => asProviderName('aws-main'), runQuery: (sql) => fetchRows(conn, sql) }),
    };
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
    rmSync(rollupDir, { recursive: true, force: true });
  });

  async function rawBilled(where: string, source = RAW_FIXTURE): Promise<{ cost: number; rows: number }> {
    const r = (await fetchRows(conn, `
      SELECT COALESCE(SUM(BilledCost), 0) AS c, COUNT(*) AS n FROM ${source}
      WHERE ChargePeriodStart::DATE BETWEEN DATE '${RANGE.start}' AND DATE '${RANGE.end}' AND (${where})`))[0];
    return { cost: Number(r?.['c']), rows: Number(r?.['n']) };
  }

  function withScope<T>(next: CostScopeConfig, run: () => Promise<T>): Promise<T> {
    scope = next;
    return run().finally(() => { scope = { costMetric: 'billed', rules: [] }; });
  }

  describe('overview', () => {
    it('totals the window from the raw Parquet', async () => {
      const result = await queryExplorerOverview(deps, base);
      const expected = await rawBilled('TRUE');
      expect(result.windowDays).toBe(30);
      expect(result.totalCost).toBeCloseTo(expected.cost, 6);
      expect(result.totalRows).toBe(expected.rows);
      expect(result.dailyTotals).toHaveLength(30);
    });

    it('binds filter values, quotes included', async () => {
      const quoted = await queryExplorerOverview(deps, { ...base, filters: { tag_team: ["o'brien"] } });
      expect(quoted.totalCost).toBe(0);
      const identity = await queryExplorerOverview(deps, { ...base, filters: { tag_team: ['identity'] } });
      expect(identity.totalCost).toBeCloseTo((await rawBilled(`element_at(Tags, 'team')[1] = 'identity'`)).cost, 6);
    });

    it('applies the cost scope NULL-safely when asked to', async () => {
      const all = await rawBilled('TRUE');
      const identity = await rawBilled(`element_at(Tags, 'team')[1] = 'identity'`);
      const scoped = await withScope({ costMetric: 'billed', rules: [identityRule] }, () =>
        queryExplorerOverview(deps, { ...base, applyCostScope: true, costMetric: 'billed' }));
      expect(scoped.totalCost).toBeCloseTo(all.cost - identity.cost, 6);
      const unscoped = await withScope({ costMetric: 'billed', rules: [identityRule] }, () =>
        queryExplorerOverview(deps, base));
      expect(unscoped.totalCost).toBeCloseTo(all.cost, 6);
    });

    it('reads a built rollup for the dashboard table, matching the raw totals', async () => {
      const ruleScope: CostScopeConfig = { costMetric: 'billed', rules: [identityRule] };
      const store = new RollupStore({ dataDir: rollupDir, providerName: () => asProviderName('aws-main'), runQuery: (sql) => fetchRows(conn, sql) });
      await store.maintainPeriods(
        ['2026-01', '2026-02'],
        (period, outPath) => buildRollupPartitionQuery(period, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions: FIXTURE_DIMENSIONS, providers: [{ name: asProviderName('aws-main'), availablePeriods: [period] }], costScope: ruleScope }),
        { '2026-01': { a: '1' }, '2026-02': { b: '2' } },
        { signature: 'SIG', grainDimensions: rollupGrainColumns(FIXTURE_DIMENSIONS) },
      );
      // The dashboard widget's shape: global scope, no metric override.
      const params = { ...base, applyCostScope: true, filters: { charge_category: ['Usage'], service: [] } };
      const raw = await withScope(ruleScope, () => queryExplorerOverview(deps, params));
      materializedFlags.length = 0;
      const rolled = await withScope(ruleScope, () => queryExplorerOverview({ ...deps, rollupStore: store }, params));
      expect(materializedFlags).toEqual([true, true]);
      expect(rolled.totalCost).toBeCloseTo(raw.totalCost, 6);
      expect(rolled.totalRows).toBe(raw.totalRows);
      expect(rolled.dailyTotals).toHaveLength(raw.dailyTotals.length);
    });

    it('degrades to an empty overview when its queries fail', async () => {
      const result = await queryExplorerOverview({ ...deps, runPreparedQuery: () => Promise.reject(new Error('worker gone')) }, base);
      expect(result).toMatchObject({ totalCost: 0, totalRows: 0, dailyTotals: [] });
    });

    it('returns the zero overview when no month is on disk', async () => {
      const result = await queryExplorerOverview(deps, { filters: {}, dateRange: { start: asDateString('2030-01-01'), end: asDateString('2030-01-31') } });
      expect(result).toMatchObject({ totalCost: 0, totalRows: 0, dailyTotals: [] });
    });
  });

  describe('rows', () => {
    it('binds the row limit and sorts', async () => {
      const result = await queryExplorerRows(deps, { ...base, rowLimit: 5, sort: { column: 'cost', direction: 'asc' } });
      expect(result.sampleRows).toHaveLength(5);
      const costs = result.sampleRows.map(r => r.cost);
      expect(costs).toEqual([...costs].sort((a, b) => a - b));
      expect(result.tagColumns).toEqual([{ id: 'tag_team', label: 'Team' }]);
    });

    it('sorts by the default for a column outside the allow-list', async () => {
      const result = await queryExplorerRows(deps, { ...base, rowLimit: 20, sort: { column: 'constructor', direction: 'asc' } });
      const sizes = result.sampleRows.map(r => Math.abs(r.cost));
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    });

    it('returns no sample rows when the query fails', async () => {
      const result = await queryExplorerRows({ ...deps, runPreparedQuery: () => Promise.reject(new Error('worker gone')) }, { ...base, rowLimit: 5 });
      expect(result.sampleRows).toEqual([]);
    });

    it('filters to the dragged hour bounds on the hourly tier', async () => {
      const hours = { start: asDateString('2026-02-23'), end: asDateString('2026-02-23'), startHour: asHourString('2026-02-23 00:00:00'), endHour: asHourString('2026-02-23 23:00:00') };
      const result = await queryExplorerRows(deps, { filters: {}, dateRange: hours, rowLimit: 1000 });
      const expected = (await fetchRows(conn, `SELECT COUNT(*) AS n FROM ${RAW_HOURLY} WHERE ChargePeriodStart BETWEEN TIMESTAMP '2026-02-23 00:00:00' AND TIMESTAMP '2026-02-23 23:00:00'`))[0];
      expect(result.sampleRows).toHaveLength(Number(expected?.['n']));
      expect(result.sampleRows.every(r => r.hour.startsWith('2026-02-23'))).toBe(true);
    });
  });

  describe('aggregated table', () => {
    it('groups by an allow-listed column and narrows to an expanded row', async () => {
      const grouped = await queryAggregatedTable(deps, { ...base, groupByColumns: ['charge_category'], rowLimit: 100 });
      const usage = grouped.rows.find(r => r.values['charge_category'] === 'Usage');
      expect(usage).toBeDefined();
      expect(grouped.totalRows).toBe(grouped.rows.length);
      const narrowed = await queryAggregatedTable(deps, { ...base, groupByColumns: ['charge_category'], rowLimit: 100, rowFilters: { charge_category: 'Usage' } });
      expect(narrowed.rows).toHaveLength(1);
      expect(narrowed.rows[0]?.cost).toBeCloseTo(usage?.cost ?? Number.NaN, 6);
    });

    it('totals the window when nothing is grouped', async () => {
      const result = await queryAggregatedTable(deps, { ...base, groupByColumns: [], rowLimit: 10 });
      expect(result.totalRows).toBe(1);
      expect(result.rows[0]?.cost).toBeCloseTo((await rawBilled('TRUE')).cost, 6);
    });

    it('falls back to the cost sort for an Object.prototype key', async () => {
      const result = await queryAggregatedTable(deps, { ...base, groupByColumns: ['charge_category'], rowLimit: 100, sort: { column: 'valueOf', direction: 'asc' } });
      const costs = result.rows.map(r => r.cost);
      expect(costs).toEqual([...costs].sort((a, b) => b - a));
    });
  });

  describe('filter values', () => {
    it("lists a dimension's values under the other filters, ignoring its own", async () => {
      // Picking one service must still list every service (facet browsing),
      // narrowed by the team filter. Empty-service Marketplace rows have no
      // value to list.
      const values = await queryExplorerFilterValues(deps, { ...base, dimensionId: 'service', filters: { service: ['nope'], tag_team: ['identity'] } });
      expect(values.length).toBeGreaterThan(1);
      const total = values.reduce((sum, v) => sum + v.cost, 0);
      expect(total).toBeCloseTo((await rawBilled(`element_at(Tags, 'team')[1] = 'identity' AND COALESCE(ServiceName, '') <> ''`)).cost, 6);
    });

    it('merges account ids into their display names', async () => {
      const values = await queryExplorerFilterValues(deps, { ...base, dimensionId: 'account' });
      expect(values.map(v => v.value)).toContain('Payments Production');
      // Two accounts that share a display name collapse into one entry.
      const shared = new Map([['100000000001', 'Production'], ['100000000002', 'Production']]);
      const merged = await queryExplorerFilterValues({ ...deps, getAccountMap: () => Promise.resolve(shared) }, { ...base, dimensionId: 'account' });
      const production = merged.find(v => v.value === 'Production');
      const both = await rawBilled(`SubAccountId IN ('100000000001', '100000000002')`);
      expect(production?.cost).toBeCloseTo(both.cost, 6);
      expect(production?.rows).toBe(both.rows);
    });
  });
});
