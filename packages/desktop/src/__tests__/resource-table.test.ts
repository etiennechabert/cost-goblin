import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { logger } from '@costgoblin/core';
import { registerExplorerHandlers } from '../main/handlers/explorer.js';
import { at, createHarness, FEBRUARY_READABLE_NOW_MS, FIXTURE_AWS_PROVIDER, list, num, str, type Harness } from './helpers/ipc-harness.js';

/** The dashboard's breakdown table (grouped by resource and description)
 *  through `explorer:query-aggregated-table`, over a real in-process DuckDB
 *  and a copy of the synthetic tree, once the resource rollup is built. Every
 *  rollup-served answer is compared with what raw Parquet gives for the same
 *  request. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const JANUARY = { start: '2026-01-01', end: '2026-01-31' };
const FEBRUARY = { start: '2026-02-01', end: '2026-02-28' };
const BOTH_MONTHS = { start: '2026-01-12', end: '2026-02-17' };
const EC2 = 'Amazon Elastic Compute Cloud';
const PAIR = ['resource_id', 'description'];

interface TableRow {
  readonly values: Readonly<Record<string, string>>;
  readonly cost: number;
  readonly listCost: number;
  readonly usageAmount: number;
  readonly rowCount: number;
}

function tableRows(result: unknown): TableRow[] {
  return list(at(result, 'rows')).map((row) => {
    const values: Record<string, string> = {};
    const rawValues = at(row, 'values');
    if (typeof rawValues !== 'object' || rawValues === null) throw new Error('row without values');
    for (const [id, value] of Object.entries(rawValues)) values[id] = str(value);
    return { values, cost: num(at(row, 'cost')), listCost: num(at(row, 'listCost')), usageAmount: num(at(row, 'usageAmount')), rowCount: num(at(row, 'rowCount')) };
  });
}

type TableParams = Readonly<Record<string, unknown>>;

/** What a page is ordered by: a measure, rounded past the last bits two sums
 *  of the same line items taken in different orders differ in, or a grouped
 *  column's text. */
function sortKeyOf(params: TableParams): (row: TableRow) => string | number {
  const sort = params['sort'];
  const column = typeof sort === 'object' && sort !== null && 'column' in sort ? sort.column : 'cost';
  const rounded = (n: number): number => Math.round(n * 1e6) / 1e6;
  switch (column) {
    case 'cost': return row => rounded(row.cost);
    case 'abs_cost': return row => rounded(Math.abs(row.cost));
    case 'row_count': return row => row.rowCount;
    default: return row => row.values[String(column)] ?? '';
  }
}

/** The same page: the same sort keys in the same order, and the same rows
 *  behind them, measure for measure. Rows that tie on the sort key come in
 *  any order, and those tying with a full page's last row may be other rows:
 *  which of them make the page is the engine's pick on both paths. */
function expectSamePage(actual: readonly TableRow[], expected: readonly TableRow[], params: TableParams): void {
  const keyOf = sortKeyOf(params);
  expect(actual.map(keyOf)).toEqual(expected.map(keyOf));
  const limit = typeof params['rowLimit'] === 'number' ? params['rowLimit'] : 500;
  const lastKey = actual.length < limit ? undefined : actual.at(-1);
  const boundary = lastKey === undefined ? undefined : keyOf(lastKey);
  const settled = (rows: readonly TableRow[]): TableRow[] => rows
    .filter(row => keyOf(row) !== boundary)
    .sort((a, b) => JSON.stringify([keyOf(a), a.values]).localeCompare(JSON.stringify([keyOf(b), b.values])));
  const ours = settled(actual);
  const theirs = settled(expected);
  expect(ours.map(r => r.values)).toEqual(theirs.map(r => r.values));
  ours.forEach((row, i) => {
    const other = theirs[i];
    expect(row.cost).toBeCloseTo(other?.cost ?? Number.NaN, 6);
    expect(row.listCost).toBeCloseTo(other?.listCost ?? Number.NaN, 6);
    expect(row.usageAmount).toBeCloseTo(other?.usageAmount ?? Number.NaN, 6);
    expect(row.rowCount).toBe(other?.rowCount);
  });
}

/** The fixture's pairs are mostly one line item each, so its 60th pair costs
 *  about what its 10th does. A bill has a few pairs far above the rest: add
 *  twelve, billed every day of both months for hundreds of dollars a day, one
 *  of them a credit. Each costs a different amount, so they never tie. */
async function addHeavyPairs(h: Harness): Promise<void> {
  for (const month of ['2026-01', '2026-02']) {
    const dir = join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw', `daily-${month}`);
    const cost = `(CASE WHEN n = 11 THEN -1 ELSE 1 END * (1000 - n * 37 + d))::DOUBLE`;
    await h.db.runQuery(`COPY (
      SELECT template.* REPLACE (
        TIMESTAMP '${month}-01' + INTERVAL (d) DAY AS ChargePeriodStart,
        'arn:test:heavy-' || n AS ResourceId, 'heavy pair ' || n AS ChargeDescription,
        ${cost} AS EffectiveCost, ${cost} AS BilledCost, ${cost} * 1.5 AS ListCost, ${cost} AS ContractedCost)
      FROM (SELECT * FROM read_parquet('${join(dir, 'data.parquet')}')
            WHERE ServiceName = '${EC2}' AND PricingCategory = 'Standard' ORDER BY ChargePeriodStart, ResourceId LIMIT 1) AS template,
           range(12) AS pairs(n), range(28) AS days(d)
    ) TO '${join(dir, 'heavy.parquet')}' (FORMAT PARQUET)`);
  }
}

async function builtApp(pairsPerMonth?: number): Promise<Harness> {
  const h = await createHarness({
    data: 'synthetic',
    rollupBuilds: true,
    now: () => FEBRUARY_READABLE_NOW_MS,
    ...(pairsPerMonth === undefined ? {} : { overrides: () => ({ resourceRollupPairsPerMonth: pairsPerMonth }) }),
  });
  registerExplorerHandlers(h.app);
  await addHeavyPairs(h);
  h.app.warmupBase();
  await h.app.awaitWarmup(10_000);
  await h.app.awaitResourceRollup();
  expect([...h.app.resourceRollupStore.getValidPeriods()].sort((a, b) => a.localeCompare(b))).toEqual(['2026-01', '2026-02']);
  return h;
}

const readsResourceRollup = (statement: string): boolean => statement.includes('resource-rollup');

/** The table as a dashboard asks for it, and whether the answer came from the
 *  resource rollup: the last query the request ran says, since a request that
 *  gives up on the rollup reads raw Parquet afterwards. Null when it ran no
 *  query at all (every one was answered from the result cache). */
async function dashboardTable(h: Harness, params: TableParams): Promise<{ result: unknown; rolled: boolean | null }> {
  const since = h.db.statements.length;
  const result = await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, groupByColumns: PAIR, rowLimit: 500, applyCostScope: true, ...params });
  const last = h.db.statements.slice(since).at(-1);
  return { result, rolled: last === undefined ? null : readsResourceRollup(last) };
}

/** The same request with the scope's own metric named: the same numbers,
 *  which only raw Parquet is asked for. */
async function rawTable(h: Harness, params: TableParams): Promise<unknown> {
  const since = h.db.statements.length;
  const result = await h.ipc.invoke('explorer:query-aggregated-table', {
    filters: {}, groupByColumns: PAIR, rowLimit: 500, applyCostScope: true, ...params, costMetric: 'effective', deferTotalRows: false,
  });
  expect(h.db.statements.slice(since).some(readsResourceRollup)).toBe(false);
  return result;
}

/** Ask both ways, and expect the rollup's rows to be raw's. */
async function expectRolledLikeRaw(h: Harness, params: TableParams): Promise<{ result: unknown; raw: unknown }> {
  const { result, rolled } = await dashboardTable(h, params);
  expect(rolled).toBe(true);
  const raw = await rawTable(h, params);
  expectSamePage(tableRows(result), tableRows(raw), params);
  return { result, raw };
}

/** Ask both ways, and expect the request to have read raw Parquet. */
async function expectRawOnly(h: Harness, params: TableParams): Promise<unknown> {
  const { result, rolled } = await dashboardTable(h, params);
  expect(rolled).toBe(false);
  expectSamePage(tableRows(result), tableRows(await rawTable(h, params)), params);
  return result;
}

describe('the breakdown table over a resource rollup that holds every pair', () => {
  let h: Harness;
  beforeAll(async () => { h = await builtApp(); }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('reads the rollup, with the rows and the group count raw Parquet gives', async () => {
    const { result, raw } = await expectRolledLikeRaw(h, { dateRange: FEBRUARY });
    expect(tableRows(result)).toHaveLength(500);
    expect(num(at(result, 'totalRows'))).toBeGreaterThan(500);
    expect(at(result, 'totalRows')).toBe(at(raw, 'totalRows'));
    // Deferring the count changes nothing when the rollup can count.
    expect(at((await dashboardTable(h, { dateRange: FEBRUARY, deferTotalRows: true })).result, 'totalRows')).toBe(at(raw, 'totalRows'));
  });

  it('follows the range across months, the filters, the sort and extra group-by columns', async () => {
    await expectRolledLikeRaw(h, { dateRange: BOTH_MONTHS, filters: { service: [EC2] }, sort: { column: 'resource_id', direction: 'asc' }, rowLimit: 40 });
    await expectRolledLikeRaw(h, { dateRange: BOTH_MONTHS, filters: { tag_team: ['platform', ''] }, sort: { column: 'row_count', direction: 'desc' }, rowLimit: 25 });
    await expectRolledLikeRaw(h, { dateRange: BOTH_MONTHS, groupByColumns: ['usage_date', 'service', ...PAIR], granularity: 'monthly', sort: { column: 'cost', direction: 'asc' }, rowLimit: 30 });
  });

  it('gives another period\'s costs for the rows on screen, and a row\'s detail', async () => {
    const { result } = await expectRolledLikeRaw(h, { dateRange: FEBRUARY, rowLimit: 8 });
    const shown = tableRows(result).map(r => r.values);
    const previous = await expectRolledLikeRaw(h, { dateRange: JANUARY, rowKeys: shown });
    expect(tableRows(previous.result).length).toBeGreaterThan(0);
    expect(at(previous.result, 'totalRows')).toBe(at(previous.raw, 'totalRows'));

    await expectRolledLikeRaw(h, { dateRange: FEBRUARY, groupByColumns: ['usage_date', 'service', ...PAIR], rowFilters: shown[0], rowLimit: 100 });
  });

  it('reads raw Parquet for what the rollup does not hold', async () => {
    // Another metric, or no cost scope: not the numbers the rollup was built with.
    const since = h.db.statements.length;
    await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, groupByColumns: PAIR, rowLimit: 5, dateRange: FEBRUARY, applyCostScope: true, costMetric: 'billed' });
    await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, groupByColumns: PAIR, rowLimit: 5, dateRange: FEBRUARY });
    expect(h.db.statements.length).toBeGreaterThan(since);
    expect(h.db.statements.slice(since).some(readsResourceRollup)).toBe(false);
    // A grouping the pairs don't refine, a column it doesn't store, the hourly tier.
    await expectRawOnly(h, { dateRange: FEBRUARY, groupByColumns: ['description'], rowLimit: 5 });
    await expectRawOnly(h, { dateRange: FEBRUARY, groupByColumns: [...PAIR, 'operation'], rowLimit: 5 });
    await expectRawOnly(h, { dateRange: FEBRUARY, filters: { service_code: ['AmazonEC2'] }, rowLimit: 5 });
    await expectRawOnly(h, { dateRange: { start: '2026-02-25', end: '2026-02-25' }, granularity: 'hourly', rowLimit: 5 });
  });

  it('counts the groups on its own, as the table\'s count does', async () => {
    const raw = await rawTable(h, { dateRange: BOTH_MONTHS, filters: { service: [EC2] } });
    const counted = await h.ipc.invoke('explorer:count-aggregated-groups', { filters: { service: [EC2] }, groupByColumns: PAIR, dateRange: BOTH_MONTHS, applyCostScope: true });
    expect(counted).toBe(at(raw, 'totalRows'));

    const detail = tableRows(raw)[0]?.values ?? {};
    const filtered = await h.ipc.invoke('explorer:count-aggregated-groups', { filters: {}, groupByColumns: ['usage_date', ...PAIR], rowFilters: detail, dateRange: BOTH_MONTHS, applyCostScope: true });
    const rawDetail = await rawTable(h, { dateRange: BOTH_MONTHS, groupByColumns: ['usage_date', ...PAIR], rowFilters: detail });
    expect(filtered).toBe(at(rawDetail, 'totalRows'));

    expect(await h.ipc.invoke('explorer:count-aggregated-groups', { filters: {}, groupByColumns: [], dateRange: FEBRUARY })).toBe(1);
    expect(await h.ipc.invoke('explorer:count-aggregated-groups', { filters: {}, groupByColumns: PAIR, dateRange: { start: '2025-03-01', end: '2025-03-31' } })).toBe(0);
    await expect(h.ipc.invoke('explorer:count-aggregated-groups', { filters: {}, groupByColumns: PAIR, dateRange: FEBRUARY, rowFilters: 'x' })).rejects.toThrow('rowFilters must be an object');
    // A payload that is not a count request is refused before any query work.
    for (const payload of [undefined, 'x', { groupByColumns: PAIR }, { filters: { service: 'EC2' }, groupByColumns: PAIR }, { filters: {}, groupByColumns: 'resource_id' }, { filters: {}, groupByColumns: PAIR, origin: 7 }]) {
      await expect(h.ipc.invoke('explorer:count-aggregated-groups', payload)).rejects.toThrow('malformed request');
    }
  });
});

describe('the breakdown table over a resource rollup that leaves pairs out', () => {
  /** Far fewer than the ~1,500 pairs a fixture month has. */
  const PAIRS = 60;
  let h: Harness;
  let tailBound: number;
  beforeAll(async () => {
    h = await builtApp(PAIRS);
    const served = h.app.resourceRollupStore.resolveSource({ requiredPeriods: ['2026-01', '2026-02'], neededColumns: ['cost'] });
    expect(served?.complete).toBe(false);
    tailBound = served?.tailBound ?? Number.NaN;
    expect(tailBound).toBeGreaterThan(0);
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('serves a page of the costliest pairs when its last row clears the tail bound, without the count', async () => {
    const params = { dateRange: BOTH_MONTHS, rowLimit: 10, deferTotalRows: true };
    const { result, raw } = await expectRolledLikeRaw(h, params);
    expect(tableRows(result)).toHaveLength(10);
    expect(tableRows(result)[9]?.cost).toBeGreaterThan(tailBound);
    expect(at(result, 'totalRows')).toBeNull();
    expect(await h.ipc.invoke('explorer:count-aggregated-groups', { filters: {}, groupByColumns: PAIR, dateRange: BOTH_MONTHS, applyCostScope: true }))
      .toBe(at(raw, 'totalRows'));

    await expectRolledLikeRaw(h, { ...params, sort: { column: 'cost', direction: 'desc' }, rowLimit: 9 });
    await expectRolledLikeRaw(h, { ...params, sort: { column: 'abs_cost', direction: 'desc' }, rowLimit: 6 });
    await expectRolledLikeRaw(h, { ...params, filters: { service: [EC2] }, rowLimit: 5 });
  });

  it('reads raw Parquet when a pair left out could belong on the page', async () => {
    // The 400th pair costs less than a pair left out may.
    const deep = await expectRawOnly(h, { dateRange: BOTH_MONTHS, rowLimit: 400, deferTotalRows: true });
    expect(tableRows(deep)[399]?.cost).toBeLessThan(tailBound);
    expect(num(at(deep, 'totalRows'))).toBeGreaterThan(400);
    // Fewer stored pairs pass the filter than the page holds.
    await expectRawOnly(h, { dateRange: FEBRUARY, filters: { tag_team: ['security'], service: [EC2] }, rowLimit: 200, deferTotalRows: true });
    // Cheapest first, or by name: the page may start with pairs left out.
    await expectRawOnly(h, { dateRange: BOTH_MONTHS, rowLimit: 10, deferTotalRows: true, sort: { column: 'cost', direction: 'asc' } });
    await expectRawOnly(h, { dateRange: BOTH_MONTHS, rowLimit: 10, deferTotalRows: true, sort: { column: 'description', direction: 'desc' } });
    await expectRawOnly(h, { dateRange: BOTH_MONTHS, rowLimit: 10, deferTotalRows: true, sort: { column: 'abs_cost', direction: 'asc' } });
  });

  it('reads raw Parquet for a caller that wants the count with the rows', async () => {
    const result = await expectRawOnly(h, { dateRange: BOTH_MONTHS, rowLimit: 11 });
    expect(num(at(result, 'totalRows'))).toBeGreaterThan(1000);
  });

  it('serves the keyed rows of pairs it holds whole, and reads raw for one it leaves out', async () => {
    const page = await dashboardTable(h, { dateRange: FEBRUARY, rowLimit: 10, deferTotalRows: true });
    expect(page.rolled).toBe(true);
    const shown = tableRows(page.result).map(r => r.values);
    const previous = await expectRolledLikeRaw(h, { dateRange: JANUARY, rowKeys: shown });
    expect(at(previous.result, 'totalRows')).toBe(at(previous.raw, 'totalRows'));
    // The costliest pairs recur: the previous period has them.
    expect(tableRows(previous.result).length).toBeGreaterThan(0);
    // No key, no group: nothing to read.
    expect(await h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, groupByColumns: PAIR, rowLimit: 500, applyCostScope: true, dateRange: JANUARY, rowKeys: [] }))
      .toMatchObject({ rows: [], totalRows: 0 });

    const all = tableRows(await rawTable(h, { dateRange: FEBRUARY, rowLimit: 1000 }));
    const light = all.at(-1)?.values ?? {};
    await expectRawOnly(h, { dateRange: FEBRUARY, rowKeys: [...shown, light] });
    // A key without a value on a grouped column keeps no group, and is no reason to read raw.
    await expectRolledLikeRaw(h, { dateRange: FEBRUARY, rowKeys: [...shown, { resource_id: 'only-half-a-key' }] });
  });

  it('serves the detail of a pair it holds whole, and reads raw for one it leaves out', async () => {
    const page = await dashboardTable(h, { dateRange: FEBRUARY, rowLimit: 3, deferTotalRows: true });
    const heavy = tableRows(page.result)[0]?.values ?? {};
    const detail = await expectRolledLikeRaw(h, { dateRange: BOTH_MONTHS, groupByColumns: ['usage_date', 'service', ...PAIR], rowFilters: heavy, sort: { column: 'usage_date', direction: 'asc' }, rowLimit: 100 });
    expect(at(detail.result, 'totalRows')).toBe(at(detail.raw, 'totalRows'));

    const all = tableRows(await rawTable(h, { dateRange: FEBRUARY, rowLimit: 1000 }));
    await expectRawOnly(h, { dateRange: FEBRUARY, groupByColumns: ['usage_date', ...PAIR], rowFilters: all.at(-1)?.values ?? {}, rowLimit: 100 });
  });

  it('reads raw Parquet for a month whose raw files just changed, then the rollup again once rebuilt', async () => {
    // A page read from the rollup comes without its count; one read from raw
    // Parquet has it. (The rebuild's own queries run meanwhile, so the last
    // query run says nothing here.)
    const page = (dateRange: typeof FEBRUARY): Promise<unknown> =>
      h.ipc.invoke('explorer:query-aggregated-table', { filters: {}, groupByColumns: PAIR, rowLimit: 7, applyCostScope: true, deferTotalRows: true, dateRange });
    expect(at(await page(FEBRUARY), 'totalRows')).toBeNull();

    h.app.maintainRollup(['2026-02']);
    const stale = await page(FEBRUARY);
    expect(num(at(stale, 'totalRows'))).toBeGreaterThan(7);
    // January was not touched.
    expect(at(await page(JANUARY), 'totalRows')).toBeNull();

    await h.app.awaitResourceRollup();
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    const rebuilt = await expectRolledLikeRaw(h, { dateRange: FEBRUARY, rowLimit: 7, deferTotalRows: true });
    expectSamePage(tableRows(rebuilt.result), tableRows(stale), { rowLimit: 7 });
  });

  it('reads raw Parquet, and says so, when a rollup file is gone', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const dir = join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'resource-rollup', 'daily-2026-01');
    await rm(dir, { recursive: true, force: true });
    await expectRawOnly(h, { dateRange: JANUARY, rowLimit: 9, deferTotalRows: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resource-rollup: read failed, reading raw'));
    warn.mockRestore();
  });
});
