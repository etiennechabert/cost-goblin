import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerQueryHandlers } from '../main/handlers/query.js';
import { at, createHarness, isRecord, list, num, str, type Harness, type HarnessOptions } from './helpers/ipc-harness.js';

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

/** Every owner value under "Company", the one top-level node of the fixture
 *  org tree (packages/core/src/__fixtures__/config/org-tree.yaml). The
 *  synthetic tree tags payments, identity and platform among them. */
const COMPANY_VALUES: ReadonlySet<string> = new Set([
  'core-banking', 'payments', 'identity', 'platform', 'analytics', 'ml-platform', 'SRE', 'sre-emea', 'sre-us',
]);

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

/** The series of a daily result, as the stacked bar and line widgets read them. */
function groups(result: unknown): string[] {
  return list(at(result, 'groups')).map(str);
}

function breakdownOf(day: unknown): Readonly<Record<string, unknown>> {
  const breakdown = at(day, 'breakdown');
  if (!isRecord(breakdown)) throw new Error('expected a breakdown object');
  return breakdown;
}

/** One day's cost for a series: 0 when the day has none. */
function dayCost(day: unknown, series: string): number {
  const cost = breakdownOf(day)[series];
  return cost === undefined ? 0 : num(cost);
}

/** Each series' cost, summed over every day of a daily result. */
function seriesTotals(result: unknown): Map<string, number> {
  const totals = new Map<string, number>();
  for (const day of list(at(result, 'days'))) {
    for (const [series, cost] of Object.entries(breakdownOf(day))) totals.set(series, (totals.get(series) ?? 0) + num(cost));
  }
  return totals;
}

function daysByDate(result: unknown): Map<string, unknown> {
  return new Map(list(at(result, 'days')).map(d => [str(at(d, 'date')), d]));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** The bars' series are the pie's slices: the same names, the same totals. */
function expectSameSeries(daily: unknown, costs: unknown): void {
  expect(sorted(groups(daily))).toEqual(sorted(entities(costs)));
  const totals = seriesTotals(daily);
  for (const row of list(at(costs, 'rows'))) {
    expect(totals.get(str(at(row, 'entity')))).toBeCloseTo(num(at(row, 'totalCost')), 4);
  }
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

  it('names accounts as query:costs does, summing the ids that share a name on each day', async () => {
    const h = await queryApp();
    const byId = await h.ipc.invoke('query:daily-costs', { groupBy: 'account', dateRange: FEBRUARY, filters: {} });
    await withOrgNames(h);
    const named = await h.ipc.invoke('query:daily-costs', { groupBy: 'account', dateRange: FEBRUARY, filters: {} });
    expectSameSeries(named, await h.ipc.invoke('query:costs', { groupBy: 'account', dateRange: FEBRUARY, filters: {} }));
    expect(groups(named)).toEqual(expect.arrayContaining(['Payments', 'Shared Name']));
    expect(groups(named)).not.toContain('100000000002');

    const rawDays = daysByDate(byId);
    const days = list(at(named, 'days'));
    expect(days).toHaveLength(rawDays.size);
    for (const day of days) {
      const raw = rawDays.get(str(at(day, 'date')));
      expect(dayCost(day, 'Shared Name')).toBeCloseTo(dayCost(raw, '100000000002') + dayCost(raw, '100000000003'), 6);
      expect(Object.keys(breakdownOf(day))).not.toContain('100000000003');
      expect(num(at(day, 'total'))).toBeCloseTo(num(at(raw, 'total')), 6);
    }
    expect(num(at(named, 'totalCost'))).toBeCloseTo(num(at(byId, 'totalCost')), 4);
  });

  it('rolls an owner dimension up the org tree on each day, as query:costs does', async () => {
    const h = await queryApp();
    const rolled = await h.ipc.invoke('query:daily-costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {} });
    expectSameSeries(rolled, await h.ipc.invoke('query:costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {} }));
    expect(groups(rolled)).toContain('Company');
    expect(groups(rolled)).not.toContain('payments');
    expect(seriesTotals(rolled).get('Company')).toBeGreaterThan(0);

    // Each day's "Company" is that day's spend on the values under it.
    await writeFile(h.ws.orgTreePath, 'tree: []\n');
    h.app.state.orgTree = null;
    const flatDays = daysByDate(await h.ipc.invoke('query:daily-costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {} }));
    for (const day of list(at(rolled, 'days'))) {
      const raw = flatDays.get(str(at(day, 'date')));
      const underCompany = Object.keys(breakdownOf(raw))
        .filter(team => COMPANY_VALUES.has(team))
        .reduce((n, team) => n + dayCost(raw, team), 0);
      expect(dayCost(day, 'Company')).toBeCloseTo(underCompany, 6);
      expect(num(at(day, 'total'))).toBeCloseTo(num(at(raw, 'total')), 6);
    }
  });

  it('filters on an account series by the name it shows, as a click on its segment does', async () => {
    const h = await queryApp();
    await withOrgNames(h);
    const all = await h.ipc.invoke('query:daily-costs', { groupBy: 'account', dateRange: FEBRUARY, filters: {} });
    const shared = await h.ipc.invoke('query:daily-costs', { groupBy: 'account', dateRange: FEBRUARY, filters: { account: ['Shared Name'] } });
    expect(groups(shared)).toEqual(['Shared Name']);
    expect(num(at(shared, 'totalCost'))).toBeCloseTo(seriesTotals(all).get('Shared Name') ?? Number.NaN, 4);
  });
});

describe('a filter on an org-tree node', () => {
  // What a click on the "Company" slice or segment sets, and what it stands for.
  const BY_NODE = { tag_team: ['Company'] };
  const BY_VALUES = { tag_team: [...COMPANY_VALUES] };

  it('keeps the node\'s spend in the widgets that show it, under its name', async () => {
    const h = await queryApp();
    const company = seriesTotals(await h.ipc.invoke('query:daily-costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {} })).get('Company') ?? Number.NaN;
    expect(company).toBeGreaterThan(0);

    const bars = await h.ipc.invoke('query:daily-costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: BY_NODE });
    expect(groups(bars)).toEqual(['Company']);
    expect(num(at(bars, 'totalCost'))).toBeCloseTo(company, 4);
    const pie = await h.ipc.invoke('query:costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: BY_NODE });
    expect(entities(pie)).toEqual(['Company']);
    expect(num(at(pie, 'totalCost'))).toBeCloseTo(company, 4);
    const detail = await h.ipc.invoke('query:entity-detail', { entity: 'Company', dimension: 'tag_team', dateRange: FEBRUARY, filters: {} });
    expect(num(at(detail, 'totalCost'))).toBeCloseTo(company, 4);
  });

  it('keeps every value under the node in each other query', async () => {
    const h = await queryApp();
    const same = async (channel: string, argsFor: (filters: Record<string, readonly string[]>) => readonly unknown[]): Promise<void> => {
      const byNode = await h.ipc.invoke(channel, ...argsFor(BY_NODE));
      expect(byNode).toEqual(await h.ipc.invoke(channel, ...argsFor(BY_VALUES)));
    };
    await same('query:costs', filters => [{ groupBy: 'service', dateRange: FEBRUARY, filters }]);
    await same('query:daily-costs', filters => [{ groupBy: 'region', dateRange: FEBRUARY, filters }]);
    await same('query:trends', filters => [{ groupBy: 'tag_team', dateRange: FEBRUARY, filters, deltaThreshold: 0, percentThreshold: 0 }]);
    await same('query:filter-values', filters => ['service', filters, FEBRUARY]);
    await same('query:entity-detail', filters => [{ entity: EC2, dimension: 'service', dateRange: FEBRUARY, filters }]);

    const trends = await h.ipc.invoke('query:trends', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: BY_NODE, deltaThreshold: 0, percentThreshold: 0 });
    const teams = [...entities(trends, 'increases'), ...entities(trends, 'savings')];
    expect(teams.length).toBeGreaterThan(0);
    expect(teams.every(t => COMPANY_VALUES.has(t))).toBe(true);
  });

  it('reads the org tree only for a query that groups or filters by the owner dimension', async () => {
    const h = await queryApp();
    await writeFile(h.ws.orgTreePath, 'tree: [unclosed\n');
    h.app.state.orgTree = null;
    // '' (the rows with no team) names no node.
    const byService = await h.ipc.invoke('query:daily-costs', { groupBy: 'service', dateRange: FEBRUARY, filters: { region: ['eu-central-1'], tag_team: [''] } });
    expect(groups(byService)).toContain(EC2);
    // A tree that fails to load fails the queries it changes; it never reads as no tree.
    await expect(h.ipc.invoke('query:costs', { groupBy: 'service', dateRange: FEBRUARY, filters: BY_NODE })).rejects.toThrow();
    await expect(h.ipc.invoke('query:daily-costs', { groupBy: 'tag_team', dateRange: FEBRUARY, filters: {} })).rejects.toThrow();
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
    // Non-empty first: `every` on an empty list would pass whatever the filter did.
    expect(named).toContain(EC2);
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
    // Refused by the dimension allow-list, before any SQL is built: a DuckDB
    // parse error would satisfy a bare toThrow() too.
    await expect(h.ipc.invoke('query:filter-values', 'service; DROP TABLE x', {}, FEBRUARY)).rejects.toThrow('Unknown dimension "service; DROP TABLE x"');
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
