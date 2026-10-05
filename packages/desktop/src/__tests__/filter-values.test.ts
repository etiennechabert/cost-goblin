import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { SecurityError, asDimensionId, asProviderName, buildRollupPartitionQuery, rollupGrainColumns, type CostScopeConfig } from '@costgoblin/core';
import { queryFilterValues, type FilterValue, type FilterValuesDeps } from '../main/handlers/filter-values.js';
import { RollupStore } from '../main/rollup-store.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import { FIXTURE_DIMENSIONS, FIXTURE_PROVIDERS, SYNTHETIC_DIR, fixtureAccountMaps } from './helpers/synthetic-handlers.js';

const WINDOW = { start: '2026-01-20', end: '2026-02-18' };

const total = (values: readonly FilterValue[]): number => values.reduce((sum, v) => sum + v.count, 0);
const countOf = (values: readonly FilterValue[], value: string): number => values.find(v => v.value === value)?.count ?? 0;

describe('queryFilterValues (DuckDB over the synthetic fixtures, raw path)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let rollupDir: string;
  let deps: FilterValuesDeps;
  let scope: CostScopeConfig = { costMetric: 'billed', rules: [] };

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    rollupDir = mkdtempSync(join(tmpdir(), 'cg-filter-values-'));
    const { accountMap, accountReverseMap } = await fixtureAccountMaps(conn);
    deps = {
      dataDir: SYNTHETIC_DIR,
      getQueryDimensions: () => Promise.resolve(FIXTURE_DIMENSIONS),
      getAccountMap: () => Promise.resolve(accountMap),
      getAccountReverseMap: () => Promise.resolve(accountReverseMap),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      getCostScope: () => Promise.resolve(scope),
      getQueryProviders: () => Promise.resolve(FIXTURE_PROVIDERS),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
      // Never loaded, so every query takes the raw path.
      rollupStore: new RollupStore({ dataDir: rollupDir, providerName: () => asProviderName('aws-main'), runQuery: (sql) => fetchRows(conn, sql) }),
    };
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
    rmSync(rollupDir, { recursive: true, force: true });
  });

  function withScope<T>(next: CostScopeConfig, run: () => Promise<T>): Promise<T> {
    scope = next;
    return run().finally(() => { scope = { costMetric: 'billed', rules: [] }; });
  }

  it("lists a dimension's values by spend", async () => {
    const values = await queryFilterValues(deps, 'service', {}, WINDOW);
    expect(values.length).toBeGreaterThan(1);
    const counts = values.map(v => v.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  // Totals are taken over charge_category: every row has one, while `service`
  // leaves out the empty-service Marketplace rows (this handler doesn't
  // re-attribute them).
  it('a tag exclusion drops only that tag value, keeping untagged spend (#451)', async () => {
    const all = await queryFilterValues(deps, 'charge_category', {}, WINDOW);
    const teams = await queryFilterValues(deps, 'tag_team', {}, WINDOW);
    const identity = countOf(teams, 'identity');
    expect(identity).toBeGreaterThan(0);
    const rule = { id: 'identity', name: 'identity', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('tag_team'), values: ['identity'] }] };
    const scoped = await withScope({ costMetric: 'billed', rules: [rule] }, () => queryFilterValues(deps, 'charge_category', {}, WINDOW));
    // A NULL-unsafe `NOT IN` would also drop every untagged row here.
    expect(total(scoped)).toBeCloseTo(total(all) - identity, 6);
    const bypassed = await withScope({ costMetric: 'billed', rules: [rule] }, () =>
      queryFilterValues(deps, 'charge_category', {}, WINDOW, { bypassCostScope: true }));
    expect(total(bypassed)).toBeCloseTo(total(all), 6);
  });

  it('labels account values with their display names', async () => {
    const values = await queryFilterValues(deps, 'account', {}, WINDOW);
    expect(values.map(v => v.value)).toContain('Payments Production');
    expect(values.every(v => !/^\d+$/.test(v.value))).toBe(true);
  });

  it('expands an account filter written as a display name to its ids', async () => {
    const accounts = await queryFilterValues(deps, 'account', {}, WINDOW);
    const payments = countOf(accounts, 'Payments Production');
    expect(payments).toBeGreaterThan(0);
    const categories = await queryFilterValues(deps, 'charge_category', { account: ['Payments Production'] }, WINDOW);
    expect(total(categories)).toBeCloseTo(payments, 6);
  });

  it('falls back to the raw id for an account the account map does not name', async () => {
    const values = await queryFilterValues({ ...deps, getAccountMap: () => Promise.resolve(new Map()) }, 'account', {}, WINDOW);
    expect(values.map(v => v.value)).toContain('100000000001');
  });

  it('reads every month on disk when no date range is given', async () => {
    const windowed = await queryFilterValues(deps, 'charge_category', {}, WINDOW);
    const everything = await queryFilterValues(deps, 'charge_category', {});
    expect(total(everything)).toBeGreaterThan(total(windowed));
  });

  it('reads the rollup when it fits, with the exclusions it baked in applied once', async () => {
    const rule = { id: 'identity', name: 'identity', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('tag_team'), values: ['identity'] }] };
    const ruleScope: CostScopeConfig = { costMetric: 'billed', rules: [rule] };
    const store = new RollupStore({ dataDir: rollupDir, providerName: () => asProviderName('aws-main'), runQuery: (sql) => fetchRows(conn, sql) });
    await store.maintainPeriods(
      ['2026-01', '2026-02'],
      (period, outPath) => buildRollupPartitionQuery(period, 'daily', outPath, { dataDir: SYNTHETIC_DIR, dimensions: FIXTURE_DIMENSIONS, providers: [{ name: asProviderName('aws-main'), availablePeriods: [period] }], costScope: ruleScope }),
      { '2026-01': { a: '1' }, '2026-02': { b: '2' } },
      { signature: 'SIG', grainDimensions: rollupGrainColumns(FIXTURE_DIMENSIONS) },
    );
    expect(store.isReady()).toBe(true);
    const raw = await withScope(ruleScope, () => queryFilterValues(deps, 'charge_category', {}, WINDOW));
    const rolled = await withScope(ruleScope, () => queryFilterValues({ ...deps, rollupStore: store }, 'charge_category', {}, WINDOW));
    expect(total(rolled)).toBeCloseTo(total(raw), 6);
  });

  it('returns nothing when no provider has data on disk', async () => {
    const empty = await queryFilterValues({ ...deps, getQueryProviders: () => Promise.resolve([{ name: asProviderName('aws-main'), availablePeriods: [] }]) }, 'service', {}, WINDOW);
    expect(empty).toEqual([]);
  });

  it('treats a provider without a month list as having no data', async () => {
    const values = await queryFilterValues({ ...deps, getQueryProviders: () => Promise.resolve([{ name: asProviderName('aws-main') }]) }, 'service', {}, WINDOW);
    expect(values).toEqual([]);
  });

  it('refuses a dimension id the config does not know', async () => {
    await expect(queryFilterValues(deps, 'x; DROP TABLE t', {}, WINDOW)).rejects.toThrow(SecurityError);
  });
});
