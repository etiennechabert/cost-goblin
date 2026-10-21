import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerExplorerHandlers } from '../main/handlers/explorer.js';
import { at, createHarness, FEBRUARY_READABLE_NOW_MS, list, num, setCostScopeLag, str, type Harness, type HarnessOptions } from './helpers/ipc-harness.js';

/** The Explorer's IPC channels over a real in-process DuckDB and a copy of
 *  the synthetic tree: hourly drill-down, row clamping, the ungrouped
 *  aggregated total, facet filter values (self-excluded, account names
 *  merged), the rollup-routed overview, and preferences. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const FEBRUARY = { start: '2026-02-01', end: '2026-02-28' };
const ONE_DAY = { start: '2026-02-10', end: '2026-02-10' };
/** The synthetic hourly tier holds 2026-02-22..28, one 00:00 bucket per day. */
const HOURLY_DAY = { start: '2026-02-25', end: '2026-02-25' };
const NO_DATA = { start: '2025-03-01', end: '2025-03-31' };
const EC2 = 'Amazon Elastic Compute Cloud';

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function explorerApp(options: HarnessOptions = { data: 'synthetic' }): Promise<Harness> {
  const h = await createHarness(options);
  registerExplorerHandlers(h.app);
  harnesses.push(h);
  return h;
}

describe('explorer preferences', () => {
  it('round-trips preferences, and reads them ungated when the dimensions cannot load', async () => {
    const h = await explorerApp({ data: 'none' });
    await h.ipc.invoke('explorer:save-preferences', { hiddenColumns: ['description'], columnOrder: ['service', 'cost'] });
    expect(JSON.parse(await readFile(join(h.ws.stateDir, 'explorer-preferences.json'), 'utf-8'))).toMatchObject({ hiddenColumns: ['description'] });
    expect(await h.ipc.invoke('explorer:get-preferences')).toMatchObject({ hiddenColumns: ['description'], columnOrder: ['service', 'cost'] });

    // A CUR-era column id is renamed on read; with the dimensions unloadable
    // the rename runs ungated.
    await writeFile(join(h.ws.stateDir, 'explorer-preferences.json'), JSON.stringify({ hiddenColumns: ['tag_user_team'], columnOrder: [] }));
    await writeFile(h.ws.dimensionsPath, 'builtIn: 42\n');
    h.app.state.dimensions = null;
    expect(await h.ipc.invoke('explorer:get-preferences')).toMatchObject({ hiddenColumns: ['tag_team'] });
  });
});

describe('explorer:query-overview', () => {
  it('buckets an hour-bounded drag-zoom per hour on the hourly tier', async () => {
    const h = await explorerApp();
    const result = await h.ipc.invoke('explorer:query-overview', {
      filters: {}, dateRange: { ...HOURLY_DAY, startHour: '2026-02-25 00:00:00', endHour: '2026-02-25 03:00:00' }, origin: 'histogram',
    });
    expect(list(at(result, 'dailyTotals')).map(d => at(d, 'date'))).toEqual(['2026-02-25 00:00:00']);
    expect(num(at(result, 'totalRows'))).toBe(50);
    expect(h.db.statements.some(s => s.includes("usage_hour BETWEEN TIMESTAMP '2026-02-25 00:00:00' AND TIMESTAMP '2026-02-25 03:00:00'"))).toBe(true);
  });

  it('ignores malformed hour bounds and stays on the daily tier', async () => {
    const h = await explorerApp();
    const result = await h.ipc.invoke('explorer:query-overview', {
      filters: {}, dateRange: { ...ONE_DAY, startHour: "2026-02-10 08:00:00'; --", endHour: '2026-02-10 11:00:00' },
    });
    expect(list(at(result, 'dailyTotals')).map(d => at(d, 'date'))).toEqual(['2026-02-10']);
    expect(h.db.statements.every(s => !s.includes('usage_hour BETWEEN'))).toBe(true);
  });

  it('is zero-filled without data in range', async () => {
    const h = await explorerApp();
    expect(await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: NO_DATA })).toMatchObject({
      windowDays: 31, dailyTotals: [], totalRows: 0, totalCost: 0,
    });
  });

  it('serves the dashboard overview from the rollup once built, matching the raw totals', async () => {
    const h = await explorerApp({ data: 'synthetic', rollupBuilds: true, now: () => FEBRUARY_READABLE_NOW_MS });
    const raw = await h.ipc.invoke('explorer:query-overview', { filters: { service: [EC2] }, dateRange: FEBRUARY, applyCostScope: true });
    h.app.warmupBase();
    await h.app.awaitWarmup(10_000);
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    const rolled = await h.ipc.invoke('explorer:query-overview', { filters: { service: [EC2] }, dateRange: FEBRUARY, applyCostScope: true });
    expect(h.db.statements.at(-1)).toContain('rollup.parquet');
    expect(num(at(rolled, 'totalCost'))).toBeCloseTo(num(at(raw, 'totalCost')), 4);
    expect(at(rolled, 'totalRows')).toBe(at(raw, 'totalRows'));

    const unfiltered = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: true });
    expect(h.db.statements.at(-1)).toContain('rollup.parquet');
    expect(list(at(unfiltered, 'dailyTotals'))).toHaveLength(28);
  });

  it('buckets the daily tier by month or week, keeping the total of the daily overview', async () => {
    const h = await explorerApp();
    const daily = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: false });
    const monthly = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: false, granularity: 'monthly' });
    const months = list(at(monthly, 'dailyTotals'));
    expect(months.map(d => at(d, 'date'))).toEqual(['2026-02-01']);
    expect(num(at(months[0], 'cost'))).toBeCloseTo(num(at(daily, 'totalCost')), 4);
    expect(num(at(monthly, 'totalCost'))).toBeCloseTo(num(at(daily, 'totalCost')), 4);
    expect(at(monthly, 'totalRows')).toBe(at(daily, 'totalRows'));

    const weekly = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: false, granularity: 'weekly' });
    const weeks = list(at(weekly, 'dailyTotals'));
    // 2026-02-01 is a Sunday: its ISO week starts Monday 2026-01-26.
    expect(weeks.map(d => at(d, 'date'))).toEqual(['2026-01-26', '2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23']);
    expect(weeks.map(d => num(at(d, 'cost'))).reduce((sum, n) => sum + n, 0)).toBeCloseTo(num(at(daily, 'totalCost')), 4);
  });

  it('buckets the rollup-served overview by month too', async () => {
    const h = await explorerApp({ data: 'synthetic', rollupBuilds: true, now: () => FEBRUARY_READABLE_NOW_MS });
    const raw = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: true, granularity: 'monthly' });
    h.app.warmupBase();
    await h.app.awaitWarmup(10_000);
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    const rolled = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: true, granularity: 'monthly' });
    expect(h.db.statements.at(-1)).toContain('rollup.parquet');
    expect(list(at(rolled, 'dailyTotals')).map(d => at(d, 'date'))).toEqual(['2026-02-01']);
    expect(num(at(rolled, 'totalCost'))).toBeCloseTo(num(at(raw, 'totalCost')), 4);
  });

  // Answering without it would show unscoped totals as if they were scoped.
  it('refuses to answer through a cost-scope.yaml that does not load, naming it', async () => {
    const h = await explorerApp();
    await writeFile(h.ws.costScopePath, 'rules: 42\n');
    await expect(h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: ONE_DAY, applyCostScope: true }))
      .rejects.toThrow("Couldn't load cost-scope.yaml");
  });
});

// FIXTURE_NOW_MS is 2026-03-01: a 7-day lag leaves Feb 22 as the newest day.
describe('the cost scope freshness lag', () => {
  it('caps the range when the cost scope applies', async () => {
    const h = await explorerApp();
    await setCostScopeLag(h.ws, 7);
    const overview = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: true });
    expect(overview).toMatchObject({ startDate: '2026-02-01', endDate: '2026-02-22', windowDays: 22 });
    expect(at(list(at(overview, 'dailyTotals')).at(-1), 'date')).toBe('2026-02-22');
    const rows = list(at(await h.ipc.invoke('explorer:query-rows', { filters: {}, dateRange: FEBRUARY, applyCostScope: true, sort: { column: 'usage_date', direction: 'desc' }, rowLimit: 1 }), 'sampleRows'));
    expect(at(rows[0], 'date')).toBe('2026-02-22');
  });

  it('reads the newest days with the cost scope off', async () => {
    const h = await explorerApp();
    await setCostScopeLag(h.ws, 7);
    const overview = await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: FEBRUARY, applyCostScope: false });
    expect(overview).toMatchObject({ endDate: '2026-02-28', windowDays: 28 });
    expect(at(list(at(overview, 'dailyTotals')).at(-1), 'date')).toBe('2026-02-28');
  });

  it('answers a range entirely within the lag with nothing', async () => {
    const h = await explorerApp();
    await setCostScopeLag(h.ws, 7);
    const lagged = { start: '2026-02-25', end: '2026-02-28' };
    expect(await h.ipc.invoke('explorer:query-overview', { filters: {}, dateRange: lagged, applyCostScope: true }))
      .toMatchObject({ startDate: '2026-02-25', endDate: '2026-02-28', dailyTotals: [], totalCost: 0 });
    expect(await h.ipc.invoke('explorer:filter-values', { dimensionId: 'service', filters: {}, dateRange: lagged, applyCostScope: true })).toEqual([]);
    expect(list(await h.ipc.invoke('explorer:filter-values', { dimensionId: 'service', filters: {}, dateRange: lagged, applyCostScope: false })).length).toBeGreaterThan(0);
  });
});

describe('explorer:query-rows', () => {
  it('returns hourly rows with their timestamp, and clamps the row limit', async () => {
    const h = await explorerApp();
    const hourly = await h.ipc.invoke('explorer:query-rows', { filters: {}, dateRange: HOURLY_DAY, granularity: 'hourly', rowLimit: 3 });
    const rows = list(at(hourly, 'sampleRows'));
    expect(rows).toHaveLength(3);
    expect(at(rows[0], 'hour')).toBe('2026-02-25 00:00:00');

    await h.ipc.invoke('explorer:query-rows', { filters: {}, dateRange: ONE_DAY, rowLimit: Number.NaN });
    expect(h.db.statements.at(-1)).toMatch(/LIMIT 500$/);
    await h.ipc.invoke('explorer:query-rows', { filters: {}, dateRange: ONE_DAY, rowLimit: 50_000 });
    expect(h.db.statements.at(-1)).toMatch(/LIMIT 1000$/);
    const daily = await h.ipc.invoke('explorer:query-rows', { filters: {}, dateRange: ONE_DAY, rowLimit: 2.9 });
    expect(list(at(daily, 'sampleRows'))).toHaveLength(2);
    expect(at(daily, 'sampleRows', 0, 'hour')).toBe('');
  });

  it('is empty without data in range', async () => {
    const h = await explorerApp();
    expect(at(await h.ipc.invoke('explorer:query-rows', { filters: {}, dateRange: NO_DATA, rowLimit: 10 }), 'sampleRows')).toEqual([]);
  });

  it('selects no tag columns when no tag dimension is configured', async () => {
    const h = await explorerApp();
    await writeFile(h.ws.dimensionsPath, 'builtIn:\n  - name: service\n    label: Service\n    field: service\ntags: []\n');
    const result = await h.ipc.invoke('explorer:query-rows', { filters: {}, dateRange: ONE_DAY, rowLimit: 2 });
    expect(at(result, 'tagColumns')).toEqual([]);
    expect(at(result, 'sampleRows', 0, 'tags')).toEqual({});
  });
});

describe('explorer:query-aggregated-table', () => {
  it('groups usage_date by month, and a row filter on that month returns all of it', async () => {
    const h = await explorerApp();
    const byDay = await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, dateRange: FEBRUARY, groupByColumns: ['usage_date'], rowLimit: 1000 });
    expect(at(byDay, 'totalRows')).toBe(28);
    const byMonth = await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, dateRange: FEBRUARY, groupByColumns: ['usage_date'], rowLimit: 1000, granularity: 'monthly' });
    expect(at(byMonth, 'totalRows')).toBe(1);
    expect(at(byMonth, 'rows', 0, 'values', 'usage_date')).toBe('2026-02-01');
    const dayTotal = list(at(byDay, 'rows')).map(r => num(at(r, 'cost'))).reduce((sum, n) => sum + n, 0);
    expect(num(at(byMonth, 'rows', 0, 'cost'))).toBeCloseTo(dayTotal, 4);

    const drilled = await h.ipc.invoke('explorer:query-aggregated-table', {
      filters: {}, dateRange: FEBRUARY, groupByColumns: ['service'], rowLimit: 1000, granularity: 'monthly', rowFilters: { usage_date: '2026-02-01' },
    });
    const wholeMonth = await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, dateRange: FEBRUARY, groupByColumns: ['service'], rowLimit: 1000 });
    expect(at(drilled, 'totalRows')).toBe(at(wholeMonth, 'totalRows'));
    // The cost is what a single day's filter can't reach: all of February.
    const drilledCost = list(at(drilled, 'rows')).map(r => num(at(r, 'cost'))).reduce((sum, n) => sum + n, 0);
    expect(drilledCost).toBeCloseTo(dayTotal, 4);

    const byWeek = await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, dateRange: FEBRUARY, groupByColumns: ['usage_date'], rowLimit: 1000, granularity: 'weekly' });
    expect(at(byWeek, 'totalRows')).toBe(5);
  });

  it('totals the window in one row when nothing is grouped', async () => {
    const h = await explorerApp();
    const grouped = await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, dateRange: FEBRUARY, groupByColumns: ['service'], rowLimit: 1000 });
    const total = await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, dateRange: FEBRUARY, groupByColumns: [], rowLimit: 10 });
    expect(at(total, 'totalRows')).toBe(1);
    expect(at(total, 'rows', 0, 'values')).toEqual({});
    const sum = list(at(grouped, 'rows')).reduce<number>((n, r) => n + num(at(r, 'cost')), 0);
    expect(num(at(total, 'rows', 0, 'cost'))).toBeCloseTo(sum, 4);
    expect(num(at(total, 'rows', 0, 'rowCount'))).toBe(1403);
  });

  it('orders grouped rows by any aggregate column', async () => {
    const h = await explorerApp();
    for (const column of ['list_cost', 'usage_amount', 'row_count', 'cost']) {
      const result = await h.ipc.invoke('explorer:query-aggregated-table', {
        filters: {}, dateRange: FEBRUARY, groupByColumns: ['service'], rowLimit: 1000, sort: { column, direction: 'asc' },
      });
      const key = column === 'list_cost' ? 'listCost' : column === 'usage_amount' ? 'usageAmount' : column === 'row_count' ? 'rowCount' : 'cost';
      const values = list(at(result, 'rows')).map(r => num(at(r, key)));
      expect([...values].sort((a, b) => a - b)).toEqual(values);
    }
  });

  it('is empty without data in range', async () => {
    const h = await explorerApp();
    expect(await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, dateRange: NO_DATA, groupByColumns: [], rowLimit: 10 })).toMatchObject({ rows: [], totalRows: 0 });
  });
});

describe('explorer:filter-values', () => {
  it('lists a facet\'s values under the other filters, never its own', async () => {
    const h = await explorerApp();
    const all = list(await h.ipc.invoke('explorer:filter-values', { dimensionId: 'service', filters: {}, dateRange: FEBRUARY }));
    const ownIgnored = list(await h.ipc.invoke('explorer:filter-values', { dimensionId: 'service', filters: { service: [EC2] }, dateRange: FEBRUARY }));
    expect(ownIgnored).toEqual(all);
    const narrowed = list(await h.ipc.invoke('explorer:filter-values', { dimensionId: 'service', filters: { service: [EC2], region: ['eu-central-1'] }, dateRange: FEBRUARY }));
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.reduce<number>((n, v) => n + num(at(v, 'rows')), 0)).toBeLessThan(all.reduce<number>((n, v) => n + num(at(v, 'rows')), 0));
  });

  it('merges account ids that share a display name', async () => {
    const h = await explorerApp();
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify({
      orgId: 'o', syncedAt: '2026-02-20T00:00:00Z',
      accounts: [
        { id: '100000000002', name: 'Shared Name', ouPath: '', tags: {} },
        { id: '100000000003', name: 'Shared Name', ouPath: '', tags: {} },
      ],
    }));
    const values = list(await h.ipc.invoke('explorer:filter-values', { dimensionId: 'account', filters: {}, dateRange: FEBRUARY }));
    const shared = values.filter(v => at(v, 'value') === 'Shared Name');
    expect(shared).toHaveLength(1);
    const costs = values.map(v => num(at(v, 'cost')));
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
    expect(values.some(v => /^\d{12}$/.test(str(at(v, 'value'))))).toBe(true);
  });

  it('is empty without data in range, and refuses an unknown dimension', async () => {
    const h = await explorerApp();
    expect(await h.ipc.invoke('explorer:filter-values', { dimensionId: 'service', filters: {}, dateRange: NO_DATA })).toEqual([]);
    await expect(h.ipc.invoke('explorer:filter-values', { dimensionId: 'nope', filters: {}, dateRange: FEBRUARY })).rejects.toThrow('Unknown dimension "nope"');
  });
});
