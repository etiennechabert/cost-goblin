import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerQueryHandlers } from '../main/handlers/query.js';
import { at, createHarness, list, num, str, type Harness, type HarnessOptions } from './helpers/ipc-harness.js';

/** The dashboard query channels — costs, daily costs, entity detail, trends,
 *  filter values, missing tags and savings — run end to end against a real
 *  (in-process) DuckDB over a copy of the synthetic tree, on the raw path and
 *  on a built rollup. Covers the post-processing the handlers add on top of
 *  the core query builders: account names, org-tree rollup, value merging. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const FEBRUARY = { start: '2026-02-01', end: '2026-02-28' };
const NO_DATA = { start: '2025-03-01', end: '2025-03-31' };
const EC2 = 'Amazon Elastic Compute Cloud';

const ORG = JSON.stringify({
  orgId: 'o-1',
  syncedAt: '2026-02-20T00:00:00Z',
  accounts: [
    { id: '100000000001', name: 'Payments', ouPath: '/Root', tags: {} },
    // Two accounts sharing one display name merge into a single row.
    { id: '100000000002', name: 'Shared Name', ouPath: '/Root', tags: {} },
    { id: '100000000003', name: 'Shared Name', ouPath: '/Root', tags: {} },
  ],
});

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function queryApp(options: HarnessOptions = { data: 'synthetic' }): Promise<Harness> {
  const h = await createHarness(options);
  registerQueryHandlers(h.app);
  harnesses.push(h);
  return h;
}

async function withOrgNames(h: Harness): Promise<void> {
  await writeFile(join(h.ws.stateDir, 'org-accounts.json'), ORG);
  h.app.state.accountMap = null;
  h.app.state.accountReverseMap = null;
}

function entities(result: unknown, key = 'rows'): string[] {
  return list(at(result, key)).map(r => str(at(r, 'entity')));
}

describe('query plumbing channels', () => {
  it('cancels pending queries, awaits the warmup with a sane timeout, and clears caches', async () => {
    const h = await queryApp({ data: 'none' });
    await h.ipc.invoke('query:cancel-pending');
    expect(h.db.cancelPendingQueries).toHaveBeenCalledTimes(1);
    expect(await h.ipc.invoke('costs:await-base', 'soon')).toBe(false);
    expect(await h.ipc.invoke('costs:await-base', 50)).toBe(false);
    await h.ipc.invoke('cache:clear-all');
    expect(h.db.cancelPendingQueries).toHaveBeenCalledTimes(2);
  });
});

describe('query:costs', () => {
  it('ranks entities by cost for the period', async () => {
    const h = await queryApp();
    const result = await h.ipc.invoke('query:costs', { groupBy: 'service', dateRange: FEBRUARY, filters: {} });
    const totals = list(at(result, 'rows')).map(r => num(at(r, 'totalCost')));
    expect(totals.length).toBeGreaterThan(3);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(num(at(result, 'totalCost'))).toBeCloseTo(totals.reduce((a, b) => a + b, 0), 4);
  });

  it('is empty without touching DuckDB when no provider has data in range', async () => {
    const h = await queryApp();
    expect(await h.ipc.invoke('query:costs', { groupBy: 'service', dateRange: NO_DATA, filters: {} })).toEqual({
      rows: [], totalCost: 0, topServices: [], dateRange: NO_DATA,
    });
    expect(h.db.statements).toEqual([]);
  });

  it('names accounts and merges ids that share a name', async () => {
    const h = await queryApp();
    const byId = await h.ipc.invoke('query:costs', { groupBy: 'account', dateRange: FEBRUARY, filters: {} });
    await withOrgNames(h);
    const byName = await h.ipc.invoke('query:costs', { groupBy: 'account', dateRange: FEBRUARY, filters: {} });
    expect(entities(byName)).toEqual(expect.arrayContaining(['Payments', 'Shared Name']));
    expect(entities(byName)).toHaveLength(entities(byId).length - 1);
    expect(num(at(byName, 'totalCost'))).toBeCloseTo(num(at(byId, 'totalCost')), 4);
  });

  it('rolls an owner dimension up the org tree unless a node is being drilled into', async () => {
    const h = await queryApp();
    const rolled = await h.ipc.invoke('query:costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {} });
    expect(list(at(rolled, 'rows')).some(r => at(r, 'isVirtual') === true)).toBe(true);
    // Drilling into a node scopes to its values, with no rollup on top.
    const drilled = await h.ipc.invoke('query:costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {}, orgNodeValues: ['payments'] });
    expect(entities(drilled)).toEqual(['payments']);

    // No tree configured: the raw owner values, nothing virtual.
    await writeFile(h.ws.orgTreePath, 'tree: []\n');
    h.app.state.orgTree = null;
    const flat = await h.ipc.invoke('query:costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {} });
    expect(list(at(flat, 'rows')).some(r => at(r, 'isVirtual') === true)).toBe(false);
    expect(entities(flat)).toEqual(expect.arrayContaining(['payments', 'platform', 'frontend']));
    expect(num(at(flat, 'totalCost'))).toBeCloseTo(num(at(rolled, 'totalCost')), 4);
  });
});

describe('query:daily-costs', () => {
  it('builds one entry per day with a per-group breakdown', async () => {
    const h = await queryApp();
    const result = await h.ipc.invoke('query:daily-costs', { groupBy: 'service', dateRange: FEBRUARY, filters: {} });
    const days = list(at(result, 'days'));
    expect(days).toHaveLength(28);
    expect(at(days[0], 'date')).toBe('2026-02-01');
    const day = days[0];
    const breakdown = at(day, 'breakdown');
    const parts = Object.values(typeof breakdown === 'object' && breakdown !== null ? breakdown : {}).map(Number);
    expect(num(at(day, 'total'))).toBeCloseTo(parts.reduce((a, b) => a + b, 0), 6);
    expect(list(at(result, 'groups'))).toContain(EC2);
    expect(num(at(result, 'totalCost'))).toBeCloseTo(days.reduce<number>((n, d) => n + num(at(d, 'total')), 0), 4);
  });

  it('is empty when no provider has data in range', async () => {
    const h = await queryApp();
    expect(await h.ipc.invoke('query:daily-costs', { groupBy: 'service', dateRange: NO_DATA, filters: {} })).toEqual({ days: [], groups: [], totalCost: 0 });
  });
});

describe('query:entity-detail', () => {
  it('details one entity with account names resolved', async () => {
    const h = await queryApp();
    await withOrgNames(h);
    const result = await h.ipc.invoke('query:entity-detail', { entity: EC2, dimension: 'service', dateRange: FEBRUARY, filters: {} });
    expect(at(result, 'entity')).toBe(EC2);
    expect(num(at(result, 'totalCost'))).toBeGreaterThan(0);
    expect(list(at(result, 'dailyCosts')).length).toBeGreaterThan(0);
    const accounts = list(at(result, 'byAccount')).map(a => str(at(a, 'name')));
    expect(accounts).toEqual(expect.arrayContaining(['Payments']));
  });

  it('is zero-filled when no provider has data in range', async () => {
    const h = await queryApp();
    expect(await h.ipc.invoke('query:entity-detail', { entity: EC2, dimension: 'service', dateRange: NO_DATA, filters: {} })).toEqual({
      entity: EC2, totalCost: 0, previousCost: 0, percentChange: 0, dailyCosts: [], byAccount: [], byService: [], bySubEntity: [],
    });
  });
});

describe('query:trends', () => {
  it('compares the period with the one before, honouring filters', async () => {
    const h = await queryApp();
    const all = await h.ipc.invoke('query:trends', { groupBy: 'service', dateRange: FEBRUARY, filters: {}, deltaThreshold: 0, percentThreshold: 0 });
    const filtered = await h.ipc.invoke('query:trends', { groupBy: 'service', dateRange: FEBRUARY, filters: { service: [EC2] }, deltaThreshold: 0, percentThreshold: 0 });
    const named = [...entities(filtered, 'increases'), ...entities(filtered, 'savings')];
    expect(named.every(e => e === EC2)).toBe(true);
    expect([...entities(all, 'increases'), ...entities(all, 'savings')].length).toBeGreaterThan(named.length);
  });
});

describe('query:filter-values', () => {
  it('lists a dimension\'s values by cost, narrowed by the other active filters', async () => {
    const h = await queryApp();
    const all = await h.ipc.invoke('query:filter-values', 'service', {}, FEBRUARY);
    expect(list(all).map(v => at(v, 'value'))).toContain(EC2);
    const one = list(await h.ipc.invoke('query:filter-values', 'service', { region: ['eu-central-1'] }, FEBRUARY));
    const two = list(await h.ipc.invoke('query:filter-values', 'service', { region: ['eu-central-1', 'us-east-1'], service: [] }, FEBRUARY));
    const total = (values: readonly unknown[]): number => values.reduce<number>((n, v) => n + num(at(v, 'count')), 0);
    expect(total(one)).toBeLessThan(total(two));
    expect(total(two)).toBeLessThan(total(list(all)));
    expect(at(one[0], 'label')).toBe(at(one[0], 'value'));
  });

  it('resolves an account-name filter to every id carrying it, and names account values', async () => {
    const h = await queryApp();
    await withOrgNames(h);
    const byName = list(await h.ipc.invoke('query:filter-values', 'service', { account: ['Shared Name'] }, FEBRUARY));
    const byIds = list(await h.ipc.invoke('query:filter-values', 'service', { account: ['100000000002', '100000000003'] }, FEBRUARY));
    expect(byName).toEqual(byIds);
    const accounts = list(await h.ipc.invoke('query:filter-values', 'account', {}, FEBRUARY)).map(v => at(v, 'value'));
    expect(accounts).toEqual(expect.arrayContaining(['Payments', 'Shared Name']));
    expect(accounts.filter(a => a === 'Shared Name')).toHaveLength(1);
  });

  it('applies the cost scope unless bypassed, and spans all months without a date range', async () => {
    const h = await queryApp();
    await writeFile(h.ws.costScopePath, [
      'costMetric: billed',
      'rules:',
      '  - id: no-ec2',
      '    name: No EC2',
      '    enabled: true',
      '    conditions:',
      '      - dimensionId: service',
      '        values:',
      `          - ${EC2}`,
      '',
    ].join('\n'));
    const scoped = list(await h.ipc.invoke('query:filter-values', 'service', {}, FEBRUARY)).map(v => at(v, 'value'));
    expect(scoped).not.toContain(EC2);
    const bypassed = list(await h.ipc.invoke('query:filter-values', 'service', {}, FEBRUARY, { bypassCostScope: true })).map(v => at(v, 'value'));
    expect(bypassed).toContain(EC2);
    const allTime = list(await h.ipc.invoke('query:filter-values', 'service', {}, undefined, { bypassCostScope: true }, 'filter-bar'));
    const feb = list(await h.ipc.invoke('query:filter-values', 'service', {}, FEBRUARY, { bypassCostScope: true }));
    expect(allTime.reduce<number>((n, v) => n + num(at(v, 'count')), 0)).toBeGreaterThan(feb.reduce<number>((n, v) => n + num(at(v, 'count')), 0));
  });

  it('returns nothing without data, and refuses an unknown dimension', async () => {
    const empty = await queryApp({ data: 'none' });
    expect(await empty.ipc.invoke('query:filter-values', 'service', {})).toEqual([]);
    const h = await queryApp();
    await expect(h.ipc.invoke('query:filter-values', 'service; DROP TABLE x', {}, FEBRUARY)).rejects.toThrow();
  });

  it('reads from the rollup once it is built for the period', async () => {
    const h = await queryApp({ data: 'synthetic', rollupBuilds: true });
    h.app.warmupBase();
    await h.app.awaitWarmup(10_000);
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    const values = list(await h.ipc.invoke('query:filter-values', 'service', { region: ['eu-central-1'] }, FEBRUARY));
    expect(values.length).toBeGreaterThan(0);
    const last = h.app.queryLog.getEntries().at(-1);
    expect(last?.materialized).toBe(true);
    expect(h.db.statements.at(-1)).toContain('rollup.parquet');
  });
});

describe('query:missing-tags and query:savings', () => {
  it('missing tags are empty without data in range', async () => {
    const h = await queryApp();
    expect(await h.ipc.invoke('query:missing-tags', { dateRange: NO_DATA, filters: {}, minCost: 0, tagDimension: 'tag_team' })).toMatchObject({
      rows: [], totalRows: 0, actionableCount: 0, nonResourceRows: [],
    });
  });

  it('savings are empty while no provider has cost-optimization data', async () => {
    const h = await queryApp({ data: 'none' });
    expect(await h.ipc.invoke('query:savings')).toEqual({ recommendations: [], totalMonthlySavings: 0 });
  });
});
