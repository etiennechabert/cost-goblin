import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { registerDimensionsHandlers } from '../main/handlers/dimensions.js';
import {
  FIXTURE_AWS_PROVIDER,
  FIXTURE_CONFIG_DIR,
  at,
  createHarness,
  list,
  num,
  type Harness,
  type HarnessOptions,
} from './helpers/ipc-harness.js';

/** The Dimensions editor's IPC surface, run against a real (in-process)
 *  DuckDB over a copy of the synthetic tree: tag discovery, the built-in
 *  preview with its org/region/normalize transforms, save validation, the
 *  rollup grain estimate, and alias suggestions with dismiss / accept. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const AWS = FIXTURE_AWS_PROVIDER;
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function dimsApp(options: HarnessOptions = { data: 'synthetic' }): Promise<Harness> {
  const h = await createHarness(options);
  registerDimensionsHandlers(h.app);
  harnesses.push(h);
  return h;
}

function values(preview: unknown): string[] {
  return list(at(preview, 'values')).map(v => String(at(v, 'value')));
}

const REGIONS = JSON.stringify({
  syncedAt: '2026-02-20T00:00:00Z',
  regions: {
    'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' },
    'eu-west-1': { longName: 'Europe (Ireland)', country: 'IE', continent: 'EU' },
    'us-east-1': { longName: 'US East (N. Virginia)', country: 'US', continent: '' },
    'us-west-2': { longName: 'US West (Oregon)', country: 'US', continent: 'NA' },
  },
});

/** A daily month of Tags-only rows the alias suggester reads (it scans the
 *  latest daily directory). */
async function writeTagMonth(h: Harness, rows: readonly Record<string, string>[]): Promise<void> {
  const dir = join(h.ws.dataDir, AWS, 'raw', 'daily-2026-03');
  await mkdir(dir, { recursive: true });
  const valuesSql = rows
    .map(r => `(MAP {${Object.entries(r).map(([k, v]) => `'${k}': '${v}'`).join(', ')}})`)
    .join(', ');
  await h.db.runQuery(`COPY (SELECT * FROM (VALUES ${valuesSql}) t(Tags)) TO '${join(dir, 'data.parquet')}' (FORMAT PARQUET)`);
}

const SUGGESTION_DIMENSIONS = [
  'builtIn:',
  '  - name: account',
  '    label: Account',
  '    field: account_id',
  '    displayField: account_name',
  'tags:',
  '  - tagName: squad',
  '    label: Squad',
  '    aliases:',
  '      core-banking:',
  '        - core_banking',
  '  - tagName: env',
  '    label: Env',
  '    normalize: lowercase',
  '  - tagName: owner',
  '    label: Owner',
  '',
].join('\n');

describe('dimensions:discover-tags', () => {
  it('reports each tag key over the last 30 days with coverage and sample values', async () => {
    const h = await dimsApp();
    const result = await h.ipc.invoke('dimensions:discover-tags');
    expect(at(result, 'samplePeriod')).toBe('last 30 days (since 2026-01-30)');
    const tags = list(at(result, 'tags'));
    expect(tags.map(t => at(t, 'key')).sort()).toEqual(['environment', 'system', 'team']);
    const team = tags.find(t => at(t, 'key') === 'team');
    expect(at(team, 'distinctCount')).toBe(8);
    expect(list(at(team, 'sampleValues'))).toHaveLength(8);
    expect(num(at(team, 'coveragePct'))).toBeGreaterThan(0);
    expect(num(at(team, 'coveragePct'))).toBeLessThanOrEqual(100);
  });

  it('finds nothing while no provider is configured', async () => {
    const h = await dimsApp();
    const config = await h.app.getConfig();
    h.app.state.config = { ...config, providers: [] };
    expect(await h.ipc.invoke('dimensions:discover-tags')).toEqual({ tags: [], samplePeriod: '' });
  });

  it('globs every daily directory when none has a well-formed month name', async () => {
    const h = await dimsApp({ data: 'none' });
    const odd = join(h.ws.dataDir, AWS, 'raw', 'daily-2026-13');
    await mkdir(odd, { recursive: true });
    await h.db.runQuery(`COPY (SELECT TIMESTAMP '2026-02-20' AS ChargePeriodStart, MAP {'team': 'x', '': 'unnamed'} AS Tags) TO '${join(odd, 'data.parquet')}' (FORMAT PARQUET)`);
    const result = await h.ipc.invoke('dimensions:discover-tags');
    // The key-less entry is dropped.
    expect(at(result, 'tags')).toEqual([{ key: 'team', sampleValues: ['x'], rowCount: 1, distinctCount: 1, coveragePct: 100 }]);
    expect(h.db.statements.some(s => s.includes('daily-*/*.parquet'))).toBe(true);
  });
});

describe('dimensions:get-config and dimensions:save-config', () => {
  it('serves the raw config and persists a validated save, dropping the cached one', async () => {
    const h = await dimsApp();
    const config = await h.ipc.invoke('dimensions:get-config');
    expect(config).toBe(await h.app.getDimensions());
    const current = await h.app.getDimensions();
    const relabeled = { ...current, builtIn: current.builtIn.map(d => (d.name === 'service' ? { ...d, label: 'Cloud Service' } : d)) };
    await h.ipc.invoke('dimensions:save-config', relabeled);
    expect(h.app.state.dimensions).toBeNull();
    const saved: unknown = parse(await readFile(h.ws.dimensionsPath, 'utf-8'));
    expect(list(at(saved, 'builtIn')).find(d => at(d, 'name') === 'service')).toMatchObject({ label: 'Cloud Service' });
  });

  it('refuses an invalid payload without touching the file', async () => {
    const h = await dimsApp();
    const before = await readFile(h.ws.dimensionsPath, 'utf-8');
    await expect(h.ipc.invoke('dimensions:save-config', { builtIn: 'nope', tags: [] })).rejects.toThrow();
    expect(await readFile(h.ws.dimensionsPath, 'utf-8')).toBe(before);
  });
});

describe('dimensions:discover-column-values', () => {
  it('previews the latest month\'s values for an allowed column, by cost', async () => {
    const h = await dimsApp();
    const preview = await h.ipc.invoke('dimensions:discover-column-values', 'service');
    expect(at(preview, 'period')).toBe('2026-02');
    expect(num(at(preview, 'distinctCount'))).toBe(values(preview).length);
    const costs = list(at(preview, 'values')).map(v => num(at(v, 'cost')));
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
    expect(at(preview, 'stripIssues')).toEqual({ invalid: [], slow: [], skipped: [] });
  });

  it('refuses columns outside the allow-list and malformed strip patterns before any query', async () => {
    const h = await dimsApp();
    const empty = { values: [], distinctCount: 0, period: '', stripIssues: { invalid: [], slow: [], skipped: [] } };
    expect(await h.ipc.invoke('dimensions:discover-column-values', 'service; DROP TABLE x')).toEqual(empty);
    await expect(h.ipc.invoke('dimensions:discover-column-values', 'account_id', { nameStripPatterns: 'x' }))
      .rejects.toThrow('nameStripPatterns must be an array of strings');
    expect(h.db.statements).toEqual([]);
  });

  it('returns an empty preview with no provider or no daily data', async () => {
    const empty = { values: [], distinctCount: 0, period: '', stripIssues: { invalid: [], slow: [], skipped: [] } };
    const none = await dimsApp({ config: 'none' });
    expect(await none.ipc.invoke('dimensions:discover-column-values', 'service')).toEqual(empty);
    const noData = await dimsApp({ data: 'none' });
    expect(await noData.ipc.invoke('dimensions:discover-column-values', 'service')).toEqual(empty);
  });

  it('names accounts from org data when asked, normalizing and stripping them', async () => {
    const h = await dimsApp();
    const raw = values(await h.ipc.invoke('dimensions:discover-column-values', 'account_id', { useOrgAccounts: true }));
    expect(raw.every(v => /^\d{12}$/.test(v))).toBe(true);

    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify({
      orgId: 'o', syncedAt: '2026-02-20T00:00:00Z',
      accounts: [
        { id: '100000000001', name: 'Payments Production', tags: { squad: 'pay' } },
        { id: '100000000002', name: 'Cards Production', tags: {} },
      ],
    }));
    const named = values(await h.ipc.invoke('dimensions:discover-column-values', 'account_id', {
      useOrgAccounts: true, normalize: 'uppercase', nameStripPatterns: [' PRODUCTION$'],
    }));
    expect(named).toEqual(expect.arrayContaining(['PAYMENTS', 'CARDS']));
    const byTag = values(await h.ipc.invoke('dimensions:discover-column-values', 'account_id', { useOrgAccounts: true, accountNameFromTag: 'squad' }));
    expect(byTag).toEqual(expect.arrayContaining(['pay', 'Cards Production']));
  });

  it('maps region codes to friendly names, countries or continents, merging values that share a label', async () => {
    const h = await dimsApp();
    const codes = values(await h.ipc.invoke('dimensions:discover-column-values', 'region', { useRegionNames: true }));
    expect(codes).toContain('eu-central-1');

    await writeFile(join(h.ws.stateDir, 'region-names.json'), REGIONS);
    h.app.state.regionMap = null;
    expect(values(await h.ipc.invoke('dimensions:discover-column-values', 'region'))).toContain('eu-central-1');
    expect(values(await h.ipc.invoke('dimensions:discover-column-values', 'region', { useRegionNames: true })))
      .toEqual(expect.arrayContaining(['Europe (Frankfurt)', 'US West (Oregon)', 'ap-southeast-1']));
    const countries = values(await h.ipc.invoke('dimensions:discover-column-values', 'region', { dimName: 'region_country' }));
    expect(countries).toEqual(expect.arrayContaining(['DE', 'IE', 'US']));
    expect(countries.filter(c => c === 'US')).toHaveLength(1);
    const continents = values(await h.ipc.invoke('dimensions:discover-column-values', 'region', { dimName: 'region_continent' }));
    // us-east-1 has no continent on file: its code is kept rather than an empty label.
    expect(continents).toEqual(expect.arrayContaining(['EU', 'NA', 'us-east-1', 'ap-southeast-1']));
  });

  it('previews through the cost scope it can load, and without one when it cannot', async () => {
    const h = await dimsApp();
    await writeFile(h.ws.costScopePath, 'rules: 42\n');
    const preview = await h.ipc.invoke('dimensions:discover-column-values', 'service');
    expect(values(preview).length).toBeGreaterThan(0);
  });
});

describe('dimensions:estimate-rollup-grain', () => {
  it('estimates a candidate grain from the latest month', async () => {
    const h = await dimsApp();
    const estimate = await h.ipc.invoke('dimensions:estimate-rollup-grain', await h.app.getDimensions());
    expect(at(estimate, 'probePeriod')).toBe('2026-02');
    expect(at(estimate, 'months')).toBe(2);
    expect(num(at(estimate, 'lineItems'))).toBe(1403);
    expect(num(at(estimate, 'raw', 'bytes'))).toBeGreaterThan(0);
    expect(num(at(estimate, 'candidate', 'rows'))).toBeGreaterThan(0);
    expect(at(estimate, 'current')).toBeNull();
    expect(at(estimate, 'currentMatchesCandidate')).toBe(false);
    expect(list(at(estimate, 'dims')).length).toBeGreaterThan(0);
  });

  it('still estimates when the cost scope cannot be loaded', async () => {
    const h = await dimsApp();
    await writeFile(h.ws.costScopePath, 'rules: 42\n');
    const estimate = await h.ipc.invoke('dimensions:estimate-rollup-grain', await h.app.getDimensions());
    expect(at(estimate, 'probePeriod')).toBe('2026-02');
  });

  it('knows when the built rollup already is the candidate grain', async () => {
    const h = await dimsApp({ data: 'synthetic', rollupBuilds: true });
    h.app.warmupBase();
    await h.app.awaitWarmup(10_000);
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    const estimate = await h.ipc.invoke('dimensions:estimate-rollup-grain', await h.app.getDimensions());
    expect(at(estimate, 'currentMatchesCandidate')).toBe(true);
  });

  it('refuses an invalid candidate and returns the empty estimate without data', async () => {
    const h = await dimsApp();
    await expect(h.ipc.invoke('dimensions:estimate-rollup-grain', { builtIn: 7 })).rejects.toThrow();
    const dims = await h.app.getDimensions();

    const none = await dimsApp({ config: 'none' });
    expect(await none.ipc.invoke('dimensions:estimate-rollup-grain', dims)).toMatchObject({ probePeriod: '', months: 0, current: null });
    const noData = await dimsApp({ data: 'none' });
    expect(await noData.ipc.invoke('dimensions:estimate-rollup-grain', dims)).toMatchObject({ probePeriod: '', months: 0, current: null });
    expect(noData.db.statements).toEqual([]);
  });

  it('counts only Parquet files toward the raw size, skipping what it cannot read', async () => {
    const h = await dimsApp();
    const dims = await h.app.getDimensions();
    const before = num(at(await h.ipc.invoke('dimensions:estimate-rollup-grain', dims), 'raw', 'bytes'));
    await writeFile(join(h.ws.dataDir, AWS, 'raw', 'daily-2026-01', 'notes.txt'), 'x'.repeat(10_000));
    // A dangling symlink named like a Parquet file cannot be stat'ed.
    const { symlink } = await import('node:fs/promises');
    await symlink(join(h.ws.root, 'missing.parquet'), join(h.ws.dataDir, AWS, 'raw', 'daily-2026-01', 'dangling.parquet'));
    // An entry named like an older month that is not a directory adds nothing.
    await writeFile(join(h.ws.dataDir, AWS, 'raw', 'daily-2025-12'), 'not a directory');
    expect(num(at(await h.ipc.invoke('dimensions:estimate-rollup-grain', dims), 'raw', 'bytes'))).toBe(before);
  });
});

describe('alias suggestions', () => {
  async function suggestionApp(): Promise<Harness> {
    const h = await dimsApp();
    await writeFile(h.ws.dimensionsPath, SUGGESTION_DIMENSIONS);
    await writeTagMonth(h, [
      { squad: 'billing-team' }, { squad: 'billing_team' }, { squad: 'billingteam' },
      { squad: 'core-banking' }, { squad: 'core_banking' }, { squad: 'corebanking' },
      { env: 'PRE-PROD' }, { env: 'pre_prod' }, { env: 'PreProd' },
      { owner: '' },
    ]);
    return h;
  }

  it('suggests clusters of near-duplicate values not already covered by aliases', async () => {
    const h = await suggestionApp();
    const suggestions = list(await h.ipc.invoke('dimensions:get-alias-suggestions', 'squad'));
    expect(suggestions).toHaveLength(1);
    expect(at(suggestions[0], 'canonical')).toBe('billingteam');
    expect([...list(at(suggestions[0], 'aliases'))].sort()).toEqual(['billing-team', 'billing_team']);
  });

  it('applies the tag\'s normalization before clustering', async () => {
    const h = await suggestionApp();
    const suggestions = list(await h.ipc.invoke('dimensions:get-alias-suggestions', 'env'));
    expect(at(suggestions[0], 'canonical')).toBe('preprod');
    expect([...list(at(suggestions[0], 'aliases'))].sort()).toEqual(['pre-prod', 'pre_prod']);
  });

  it('returns nothing for an empty or unknown tag, a tag with no values, or no data', async () => {
    const h = await suggestionApp();
    expect(await h.ipc.invoke('dimensions:get-alias-suggestions', '')).toEqual([]);
    expect(await h.ipc.invoke('dimensions:get-alias-suggestions', 'nope')).toEqual([]);
    expect(await h.ipc.invoke('dimensions:get-alias-suggestions', 'owner')).toEqual([]);

    const noData = await dimsApp({ data: 'none' });
    await writeFile(noData.ws.dimensionsPath, SUGGESTION_DIMENSIONS);
    expect(await noData.ipc.invoke('dimensions:get-alias-suggestions', 'squad')).toEqual([]);

    const onboarding = await dimsApp({ config: 'none' });
    await copyFile(join(FIXTURE_CONFIG_DIR, 'dimensions.yaml'), onboarding.ws.dimensionsPath);
    expect(await onboarding.ipc.invoke('dimensions:get-alias-suggestions', 'team')).toEqual([]);
  });

  it('remembers a dismissed suggestion, once', async () => {
    const h = await suggestionApp();
    await h.ipc.invoke('dimensions:dismiss-suggestion', 'squad', 'billingteam', ['billing_team', 'billing-team']);
    await h.ipc.invoke('dimensions:dismiss-suggestion', 'squad', 'billingteam', ['billing-team', 'billing_team']);
    const stored: unknown = JSON.parse(await readFile(join(h.ws.stateDir, 'dismissed-suggestions.json'), 'utf-8'));
    expect(list(at(stored, 'dismissed'))).toHaveLength(1);
    expect(await h.ipc.invoke('dimensions:get-alias-suggestions', 'squad')).toEqual([]);
    // A dismissal for another alias set or tag does not hide this one.
    expect(list(await h.ipc.invoke('dimensions:get-alias-suggestions', 'env'))).toHaveLength(1);
  });

  it('ignores a dismissed-suggestions file it cannot trust', async () => {
    const h = await suggestionApp();
    const file = join(h.ws.stateDir, 'dismissed-suggestions.json');
    for (const content of ['{ broken', JSON.stringify({ dismissed: 'all' }), JSON.stringify({
      dismissed: [
        { tagName: 'squad', canonical: 'billingteam', aliases: ['billing-team', 7], dismissedAt: 'x' },
        { tagName: 'squad', canonical: 'billingteam', aliases: ['billing-team', 'billing_team'] },
        'junk',
      ],
    })]) {
      await writeFile(file, content);
      expect(list(await h.ipc.invoke('dimensions:get-alias-suggestions', 'squad'))).toHaveLength(1);
    }
  });

  it('accepting a suggestion writes the aliases onto the tag; an unknown tag writes nothing', async () => {
    const h = await suggestionApp();
    await h.ipc.invoke('dimensions:accept-suggestion', 'squad', 'billingteam', ['billing-team', 'billing_team']);
    const saved: unknown = parse(await readFile(h.ws.dimensionsPath, 'utf-8'));
    const squad = list(at(saved, 'tags')).find(t => at(t, 'tagName') === 'squad');
    expect(at(squad, 'aliases', 'billingteam')).toEqual(['billing-team', 'billing_team']);
    expect(await h.ipc.invoke('dimensions:get-alias-suggestions', 'squad')).toEqual([]);

    const before = await readFile(h.ws.dimensionsPath, 'utf-8');
    await h.ipc.invoke('dimensions:accept-suggestion', 'ghost', 'a', ['b']);
    expect(await readFile(h.ws.dimensionsPath, 'utf-8')).toBe(before);
  });
});
