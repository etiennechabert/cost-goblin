import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { ConfigValidationError, asProviderName } from '@costgoblin/core';
import { previewCostScope, type CostScopePreviewDeps } from '../main/handlers/cost-scope-preview.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import {
  FIXTURE_DIMENSIONS,
  FIXTURE_NOW,
  FIXTURE_PROVIDERS,
  RAW_FIXTURE,
  SYNTHETIC_DIR,
  fixtureAccountMaps,
} from './helpers/synthetic-handlers.js';

function rule(id: string, dimensionId: string, values: string[]) {
  return { id, name: id, enabled: true, builtIn: false, conditions: [{ dimensionId, values }] };
}

describe('previewCostScope (DuckDB over the synthetic fixtures)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let deps: CostScopePreviewDeps;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    const { accountReverseMap } = await fixtureAccountMaps(conn);
    deps = {
      dataDir: SYNTHETIC_DIR,
      now: FIXTURE_NOW,
      getQueryDimensions: () => Promise.resolve(FIXTURE_DIMENSIONS),
      getQueryProviders: () => Promise.resolve(FIXTURE_PROVIDERS),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      getAccountReverseMap: () => Promise.resolve(accountReverseMap),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
    };
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  /** Effective cost of the raw fixture rows matching `where` inside the
   *  preview's window — computed without the code under test. */
  async function rawCost(start: string, end: string, where: string): Promise<number> {
    const rows = await fetchRows(conn, `
      SELECT COALESCE(SUM(EffectiveCost), 0) AS c FROM ${RAW_FIXTURE}
      WHERE ChargePeriodStart::DATE BETWEEN DATE '${start}' AND DATE '${end}' AND (${where})`);
    return Number(rows[0]?.['c']);
  }

  it('excludes nothing without an enabled rule', async () => {
    const result = await previewCostScope(deps, { costMetric: 'effective', rules: [] });
    expect(result.windowDays).toBe(30);
    expect(result.combined).toEqual({ excludedCost: 0, excludedRows: 0 });
    expect(result.unscopedTotalCost).toBeGreaterThan(0);
    expect(result.scopedTotalCost).toBeCloseTo(result.unscopedTotalCost, 6);
    expect(result.dailyTotals).toHaveLength(30);
    expect(result.sampleRows.length).toBeGreaterThan(0);
    expect(result.sampleRows.every(r => !r.excluded)).toBe(true);
  });

  it('a tag rule excludes exactly the rows carrying that tag value', async () => {
    const result = await previewCostScope(deps, { costMetric: 'effective', rules: [rule('identity', 'tag_team', ['identity'])] });
    const expected = await rawCost(result.startDate, result.endDate, `element_at(Tags, 'team')[1] = 'identity'`);
    expect(expected).toBeGreaterThan(0);
    expect(result.combined.excludedCost).toBeCloseTo(expected, 6);
    expect(result.perRule[0]?.excludedCost).toBeCloseTo(expected, 6);
    expect(result.scopedTotalCost).toBeCloseTo(result.unscopedTotalCost - expected, 6);
    expect(result.sampleRows.some(r => r.excluded)).toBe(true);
  });

  it('expands an account rule written as a display name to the account ids', async () => {
    // The preview used to match `account_id IN ('Payments Production')`, so a
    // rule that does drop the account's spend on the dashboards previewed $0.
    const scope = { costMetric: 'effective', rules: [rule('payments', 'account', ['Payments Production'])] };
    const result = await previewCostScope(deps, scope);
    const expected = await rawCost(result.startDate, result.endDate, `SubAccountId = '100000000001'`);
    expect(expected).toBeGreaterThan(0);
    expect(result.combined.excludedCost).toBeCloseTo(expected, 6);

    const withoutNames = await previewCostScope({ ...deps, getAccountReverseMap: () => Promise.resolve(new Map()) }, scope);
    expect(withoutNames.combined.excludedCost).toBe(0);
  });

  it('applies Marketplace re-attribution like the dashboards do', async () => {
    // The fixture's Bedrock spend is all third-party Marketplace rows (empty
    // service code): they only count as "Amazon Bedrock" once re-attributed,
    // which every dashboard source does and the preview used to skip.
    const bedrock = [rule('bedrock', 'service', ['Amazon Bedrock'])];
    const attribution = { rules: [{ service: 'Amazon Bedrock', operations: ['InvokeModelInference'] }] };
    const on = await previewCostScope(deps, { costMetric: 'effective', rules: bedrock, marketplaceAttribution: { ...attribution, enabled: true } });
    const off = await previewCostScope(deps, { costMetric: 'effective', rules: bedrock, marketplaceAttribution: { ...attribution, enabled: false } });
    const marketplace = await rawCost(on.startDate, on.endDate, `COALESCE(x_ServiceCode, '') = '' AND x_Operation = 'InvokeModelInference'`);
    expect(marketplace).toBeGreaterThan(0);
    expect(on.combined.excludedCost).toBeCloseTo(marketplace, 6);
    expect(off.combined.excludedCost).toBe(0);
  });

  it('treats a rule on a since-removed dimension as a no-op', async () => {
    const stale = rule('stale', 'tag_removed', ['x']);
    const result = await previewCostScope(deps, { costMetric: 'effective', rules: [stale, rule('identity', 'tag_team', ['identity'])] });
    expect(result.perRule[0]).toEqual({ ruleId: 'stale', excludedCost: 0, excludedRows: 0 });
    expect(result.perRule[1]?.excludedCost).toBeGreaterThan(0);
    expect(result.combined.excludedCost).toBeCloseTo(result.perRule[1]?.excludedCost ?? Number.NaN, 6);
  });

  it('works without tag dimensions', async () => {
    const result = await previewCostScope(
      { ...deps, getQueryDimensions: () => Promise.resolve({ ...FIXTURE_DIMENSIONS, tags: [] }) },
      { costMetric: 'effective', rules: [rule('tax', 'charge_category', ['Tax'])] },
    );
    expect(result.tagColumns).toEqual([]);
    expect(result.sampleRows.length).toBeGreaterThan(0);
    expect(result.sampleRows[0]?.tags).toEqual({});
  });

  it('reports zeros, not a failure, when its queries fail', async () => {
    const result = await previewCostScope(
      { ...deps, runPreparedQuery: () => Promise.reject(new Error('worker gone')) },
      { costMetric: 'effective', rules: [rule('identity', 'tag_team', ['identity'])] },
    );
    expect(result.unscopedTotalCost).toBe(0);
    expect(result.dailyTotals).toEqual([]);
    expect(result.sampleRows).toEqual([]);
    expect(result.perRule).toEqual([{ ruleId: 'identity', excludedCost: 0, excludedRows: 0 }]);
  });

  it('skips a provider without a month list', async () => {
    const result = await previewCostScope(
      { ...deps, getQueryProviders: () => Promise.resolve([{ name: FIXTURE_PROVIDERS[0]?.name ?? asProviderName('aws-main') }]) },
      { costMetric: 'effective', rules: [] },
    );
    expect(result.unscopedTotalCost).toBe(0);
  });

  it('returns the zero preview when no provider has data in the window', async () => {
    const result = await previewCostScope(
      { ...deps, now: () => Date.UTC(2030, 0, 1) },
      { costMetric: 'effective', rules: [rule('identity', 'tag_team', ['identity'])] },
    );
    expect(result.unscopedTotalCost).toBe(0);
    expect(result.perRule).toEqual([{ ruleId: 'identity', excludedCost: 0, excludedRows: 0 }]);
  });

  it('rejects a scope that fails validation', async () => {
    await expect(previewCostScope(deps, { costMetric: 'bogus', rules: [] })).rejects.toThrow(ConfigValidationError);
  });
});
