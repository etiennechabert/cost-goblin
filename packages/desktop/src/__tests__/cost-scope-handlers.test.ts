import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_COST_SCOPE } from '@costgoblin/core';
import { registerCostScopeHandlers } from '../main/handlers/cost-scope.js';
import { resetElectronFakes, shell } from './helpers/electron-fake.js';
import { at, createHarness, list, num, type Harness, type HarnessOptions } from './helpers/ipc-harness.js';

/** The Cost Scope editor's IPC surface: seeding a missing config, validated
 *  saves (including the dangling-dimension guard), and the live preview —
 *  per-rule and combined exclusions, daily split and sample rows — computed
 *  by a real DuckDB over a copy of the synthetic tree. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const harnesses: Harness[] = [];

beforeEach(() => {
  resetElectronFakes();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function scopeApp(options: HarnessOptions = { data: 'synthetic' }): Promise<Harness> {
  const h = await createHarness(options);
  registerCostScopeHandlers(h.app);
  harnesses.push(h);
  return h;
}

const FEBRUARY = { start: '2026-02-01', end: '2026-02-28' };

function scope(rules: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { costMetric: 'billed', rules };
}

const EXCLUDE_EC2 = {
  id: 'no-ec2', name: 'No EC2', enabled: true, builtIn: false,
  conditions: [{ dimensionId: 'service', values: ['Amazon Elastic Compute Cloud'] }],
};

describe('cost-scope:get-config', () => {
  it('serves the loaded scope', async () => {
    const h = await scopeApp({ data: 'none' });
    expect(await h.ipc.invoke('cost-scope:get-config')).toBe(await h.app.getCostScope());
  });

  it('seeds the default scope when the file is missing', async () => {
    const h = await scopeApp({ data: 'none' });
    await rm(h.ws.costScopePath);
    expect(await h.ipc.invoke('cost-scope:get-config')).toEqual(DEFAULT_COST_SCOPE);
    expect(at(parse(await readFile(h.ws.costScopePath, 'utf-8')), 'costMetric')).toBe(DEFAULT_COST_SCOPE.costMetric);
  });

  it('surfaces a broken hand edit instead of overwriting it', async () => {
    const h = await scopeApp({ data: 'none' });
    await writeFile(h.ws.costScopePath, 'costMetric: 12\nrules: []\n');
    await expect(h.ipc.invoke('cost-scope:get-config')).rejects.toThrow('costScope.costMetric');
    expect(await readFile(h.ws.costScopePath, 'utf-8')).toBe('costMetric: 12\nrules: []\n');
  });
});

describe('cost-scope:save-config', () => {
  it('persists a validated scope and drops the cached one', async () => {
    const h = await scopeApp({ data: 'none' });
    await h.app.getCostScope();
    await h.ipc.invoke('cost-scope:save-config', scope([EXCLUDE_EC2]));
    expect(h.app.state.costScope).toBeNull();
    const saved = parse(await readFile(h.ws.costScopePath, 'utf-8'));
    expect(at(saved, 'costMetric')).toBe('billed');
    expect(list(at(saved, 'rules')).map(r => at(r, 'id'))).toEqual(['no-ec2']);
  });

  it('refuses a rule on a dimension that does not exist, and an invalid payload', async () => {
    const h = await scopeApp({ data: 'none' });
    const before = await readFile(h.ws.costScopePath, 'utf-8');
    const dangling = { ...EXCLUDE_EC2, conditions: [{ dimensionId: 'nope', values: ['x'] }] };
    await expect(h.ipc.invoke('cost-scope:save-config', scope([dangling])))
      .rejects.toThrow("Rule 'No EC2' references unknown dimension 'nope'. Available: ");
    await expect(h.ipc.invoke('cost-scope:save-config', { costMetric: 'billed' })).rejects.toThrow('costScope.rules');
    expect(await readFile(h.ws.costScopePath, 'utf-8')).toBe(before);
  });
});

describe('cost-scope:preview', () => {
  it('splits the picked period into kept and excluded cost, per rule and combined', async () => {
    const h = await scopeApp();
    const disabled = { ...EXCLUDE_EC2, id: 'off', name: 'Off', enabled: false };
    const result = await h.ipc.invoke('cost-scope:preview', scope([EXCLUDE_EC2, disabled]), FEBRUARY);
    expect(result).toMatchObject({ windowDays: 28, startDate: '2026-02-01', endDate: '2026-02-28' });
    const unscoped = num(at(result, 'unscopedTotalCost'));
    const excluded = num(at(result, 'combined', 'excludedCost'));
    expect(excluded).toBeGreaterThan(0);
    expect(num(at(result, 'scopedTotalCost'))).toBeCloseTo(unscoped - excluded, 6);
    // Only enabled rules are tallied.
    expect(list(at(result, 'perRule')).map(r => at(r, 'ruleId'))).toEqual(['no-ec2']);
    expect(num(at(result, 'perRule', 0, 'excludedCost'))).toBeCloseTo(excluded, 6);
    expect(at(result, 'combined', 'excludedRows')).toBe(at(result, 'perRule', 0, 'excludedRows'));

    const days = list(at(result, 'dailyTotals'));
    expect(days).toHaveLength(28);
    expect(days.reduce<number>((n, d) => n + num(at(d, 'keptCost')) + num(at(d, 'excludedCost')), 0)).toBeCloseTo(unscoped, 4);

    const samples = list(at(result, 'sampleRows'));
    expect(samples.length).toBeGreaterThan(0);
    const excludedSamples = samples.filter(r => at(r, 'excluded') === true);
    expect(excludedSamples.length).toBeGreaterThan(0);
    expect(excludedSamples.every(r => at(r, 'service') === 'Amazon Elastic Compute Cloud')).toBe(true);
    expect(at(samples[0], 'date')).toMatch(/^2026-02-\d{2}$/);
    expect(at(samples[0], 'tags')).toEqual(expect.any(Object));
    expect(num(at(result, 'sampleTotalRowCount'))).toBe(1403);
    expect(list(at(result, 'tagColumns')).map(t => at(t, 'label'))).toEqual(expect.arrayContaining(['Team', 'Environment']));
  });

  it('treats a rule on an unknown dimension as excluding nothing, and no rules as no exclusion', async () => {
    const h = await scopeApp();
    const dangling = { ...EXCLUDE_EC2, id: 'dangling', conditions: [{ dimensionId: 'nope', values: ['x'] }] };
    const result = await h.ipc.invoke('cost-scope:preview', scope([dangling]), FEBRUARY);
    expect(at(result, 'perRule')).toEqual([{ ruleId: 'dangling', excludedCost: 0, excludedRows: 0 }]);
    expect(at(result, 'combined')).toEqual({ excludedCost: 0, excludedRows: 0 });

    const none = await h.ipc.invoke('cost-scope:preview', scope([]), FEBRUARY);
    expect(num(at(none, 'scopedTotalCost'))).toBeCloseTo(num(at(none, 'unscopedTotalCost')), 6);
  });

  it('previews every provider with data in the window, blanking columns a provider leaves empty', async () => {
    const h = await scopeApp({ config: 'multi', data: 'synthetic' });
    const result = await h.ipc.invoke('cost-scope:preview', scope([]), FEBRUARY);
    const single = await scopeApp();
    const aws = await single.ipc.invoke('cost-scope:preview', scope([]), FEBRUARY);
    expect(num(at(result, 'sampleTotalRowCount'))).toBeGreaterThan(num(at(aws, 'sampleTotalRowCount')));
    // GCP's FOCUS export has no x_Operation: those rows carry no operation.
    expect(list(at(result, 'sampleRows')).some(r => at(r, 'operation') === '')).toBe(true);
  });

  it('previews without tag columns when no tag dimension is configured', async () => {
    const h = await scopeApp();
    await writeFile(h.ws.dimensionsPath, 'builtIn:\n  - name: service\n    label: Service\n    field: service\ntags: []\n');
    const result = await h.ipc.invoke('cost-scope:preview', scope([EXCLUDE_EC2]), FEBRUARY);
    expect(at(result, 'tagColumns')).toEqual([]);
    expect(at(result, 'sampleRows', 0, 'tags')).toEqual({});
  });

  it('returns the zero preview when no provider has data in the window', async () => {
    const h = await scopeApp();
    const result = await h.ipc.invoke('cost-scope:preview', scope([EXCLUDE_EC2]), { start: '2025-06-01', end: '2025-06-30' });
    expect(result).toEqual({
      windowDays: 30, startDate: '2025-06-01', endDate: '2025-06-30',
      perRule: [{ ruleId: 'no-ec2', excludedCost: 0, excludedRows: 0 }],
      combined: { excludedCost: 0, excludedRows: 0 },
      unscopedTotalCost: 0, scopedTotalCost: 0, dailyTotals: [], sampleRows: [], sampleTotalRowCount: 0, tagColumns: [],
    });
    expect(h.db.statements).toEqual([]);
  });

  it('defaults to the trailing window before the lag when no valid period is picked', async () => {
    const h = await scopeApp();
    const result = await h.ipc.invoke('cost-scope:preview', { ...scope([]), lagDays: 1 }, { start: '2026-02-10', end: '2026-02-01' });
    expect(at(result, 'windowDays')).toBe(30);
    expect(at(result, 'endDate')).toBe('2026-02-28');
  });

  it('refuses an invalid scope payload', async () => {
    const h = await scopeApp();
    await expect(h.ipc.invoke('cost-scope:preview', { costMetric: 'nope', rules: [] }, FEBRUARY)).rejects.toThrow('costScope.costMetric must be one of');
  });
});

describe('cost-scope:reveal-folder', () => {
  it('shows the cost scope file in the file manager', async () => {
    const h = await scopeApp({ data: 'none' });
    await h.ipc.invoke('cost-scope:reveal-folder');
    expect(shell.showItemInFolder).toHaveBeenCalledWith(h.ws.costScopePath);
  });
});
