import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listLocalMonths, loadConfig, logger, providerEtagPath } from '@costgoblin/core';
import type { ProviderAuth, ProviderName } from '@costgoblin/core';
import { isAnyCredentialError, loadOrgAccountsMap, prefsPath, toUserFriendlyError } from '../main/handlers/context.js';
import {
  FIXTURE_AWS_PROVIDER,
  FIXTURE_GCP_PROVIDER,
  configYaml,
  createHarness,
  gcpProviderYaml,
  type Harness,
  type HarnessOptions,
} from './helpers/ipc-harness.js';

/** createAppContext: the config/dimension/org caches and what invalidates
 *  them, account + region name loading, the query result cache, the rollup
 *  warmup / re-roll lifecycle (with real partition builds against a copy of
 *  the synthetic tree), and the user-facing rewrite of sync failures. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('@costgoblin/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@costgoblin/core')>();
  // Pass-throughs, so a test can await the step a background task is on.
  return { ...actual, listLocalMonths: vi.fn(actual.listLocalMonths), loadConfig: vi.fn(actual.loadConfig) };
});

const AWS = FIXTURE_AWS_PROVIDER;
const harnesses: Harness[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(listLocalMonths).mockClear();
  vi.mocked(loadConfig).mockClear();
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const h = await createHarness(options);
  harnesses.push(h);
  return h;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** Let every queued microtask and pending I/O callback run. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

async function settled(value: unknown): Promise<void> {
  await Promise.resolve(value).then(() => undefined, () => undefined);
  await flush();
}

async function firstProvider(h: Harness): Promise<ProviderName> {
  const provider = (await h.app.getConfig()).providers[0];
  if (provider === undefined) throw new Error('fixture config has a provider');
  return provider.name;
}

const ORG = {
  orgId: 'o-1',
  syncedAt: '2026-02-20T00:00:00Z',
  accounts: [
    { id: '111111111111', name: 'Payments Prod', ouPath: '/Root/Payments', tags: { team: 'payments', env: 7 } },
    { id: '222222222222', name: 'Data Lake', ouPath: '', tags: { env: 'prod' } },
    { id: '333333333333', ouPath: '/Root/Orphans', tags: 'not-a-record' },
    { id: '777777777777', name: 'No OU', tags: {} },
    { id: '', name: 'No Id' },
    { id: 444, name: 'Numeric Id' },
    'not-an-account',
  ],
};

const MINIMAL_DIMENSIONS = (account: readonly string[] = []): string => [
  'builtIn:',
  '  - name: account',
  '    label: Account',
  '    field: account_id',
  '    displayField: account_name',
  ...account,
  '  - name: region',
  '    label: Region',
  '    field: region',
  '    useRegionNames: true',
  'tags: []',
  '',
].join('\n');

describe('toUserFriendlyError', () => {
  const aws: ProviderAuth = { kind: 'aws-profile', profile: 'billing' };
  const gcp: ProviderAuth = { kind: 'gcp', impersonateServiceAccount: 'reader@proj.iam.gserviceaccount.com' };

  it('rewrites AWS credential and download failures into the sign-in remedy', () => {
    const expired = new Error('Token is expired. To refresh this SSO session run aws sso login');
    expect(toUserFriendlyError(expired, aws).message).toBe('AWS credentials expired for profile "billing". Run: aws sso login --profile billing');
    expect(toUserFriendlyError(new Error('aws s3 sync failed: Max Retries Exceeded'), aws).message)
      .toBe('Download from S3 failed — your AWS session may have expired. Run: aws sso login --profile billing and retry. If it persists, check your network/VPN connection.');
  });

  it('leaves other AWS errors alone and wraps non-errors', () => {
    const denied = new Error('AccessDenied: not authorized to perform s3:ListBucket');
    expect(toUserFriendlyError(denied, aws)).toBe(denied);
    expect(toUserFriendlyError('plain text', aws).message).toBe('plain text');
  });

  it('rewrites each GCP failure class to its own remedy, network first', () => {
    expect(toUserFriendlyError(new Error('Please run: gcloud auth login — [Errno 65] No route to host'), gcp).message)
      .toMatch(/^Couldn't reach Google Cloud/);
    expect(toUserFriendlyError(new Error('gcloud storage rsync failed: Reauthentication failed. cannot prompt during non-interactive execution.'), gcp).message)
      .toBe('The gcloud CLI is signed in as a different account than CostGoblin\'s credentials, or its session expired. Run: gcloud auth login');
    const impersonation = toUserFriendlyError(new Error('unable to impersonate: PERMISSION_DENIED'), gcp).message;
    expect(impersonation).toContain('CostGoblin could not read as reader@proj.iam.gserviceaccount.com');
    expect(impersonation).not.toContain('Run: ');
    expect(toUserFriendlyError(new Error('Could not load the default credentials.'), gcp).message)
      .toBe('GCP credentials are missing or expired. Run: gcloud auth application-default login');
    expect(toUserFriendlyError(new Error('gcloud storage rsync failed: Max retries exceeded'), gcp).message)
      .toMatch(/^Download from Cloud Storage failed — your GCP session may have expired\. Run: gcloud auth application-default login/);
  });

  it('leaves other GCP errors alone and wraps non-errors', () => {
    const denied = new Error('403 caller does not have storage.objects.list access');
    expect(toUserFriendlyError(denied, gcp)).toBe(denied);
    expect(toUserFriendlyError(42, { kind: 'gcp' }).message).toBe('42');
  });

  it('isAnyCredentialError spans both providers, impersonation included', () => {
    expect(isAnyCredentialError(new Error('Could not load credentials from any providers'))).toBe(true);
    expect(isAnyCredentialError(new Error('Could not refresh access token'))).toBe(true);
    expect(isAnyCredentialError(new Error('unable to impersonate: NOT_FOUND'))).toBe(true);
    expect(isAnyCredentialError(new Error('NoSuchBucket'))).toBe(false);
    expect(isAnyCredentialError('Could not load credentials')).toBe(false);
  });
});

describe('loadOrgAccountsMap', () => {
  it('maps ids to names, skipping entries it cannot use', async () => {
    const h = await harness({ config: 'none' });
    expect(await loadOrgAccountsMap(h.ws.stateDir)).toEqual(new Map());
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify(ORG));
    expect(await loadOrgAccountsMap(h.ws.stateDir)).toEqual(new Map([
      ['111111111111', 'Payments Prod'],
      ['222222222222', 'Data Lake'],
      ['777777777777', 'No OU'],
    ]));
  });

  it('names accounts by a tag, or by OU path, falling back to the account name', async () => {
    const h = await harness({ config: 'none' });
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify(ORG));
    expect(await loadOrgAccountsMap(h.ws.stateDir, 'team')).toEqual(new Map([
      ['111111111111', 'payments'],
      ['222222222222', 'Data Lake'],
      ['777777777777', 'No OU'],
    ]));
    expect(await loadOrgAccountsMap(h.ws.stateDir, '__ouPath__')).toEqual(new Map([
      ['111111111111', '/Root/Payments'],
      ['222222222222', 'Data Lake'],
      ['333333333333', '/Root/Orphans'],
      ['777777777777', 'No OU'],
    ]));
    expect(await loadOrgAccountsMap(h.ws.stateDir, '')).toEqual(await loadOrgAccountsMap(h.ws.stateDir));
  });

  it('treats a malformed file as no org data', async () => {
    const h = await harness({ config: 'none' });
    for (const content of ['{ broken', '[]', JSON.stringify({ accounts: 'none' })]) {
      await writeFile(join(h.ws.stateDir, 'org-accounts.json'), content);
      expect(await loadOrgAccountsMap(h.ws.stateDir)).toEqual(new Map());
    }
  });

  it('prefsPath names a JSON file in the state dir', async () => {
    expect(await prefsPath('/state', 'ui-preferences')).toBe(join('/state', 'ui-preferences.json'));
  });
});

describe('createAppContext: config caches', () => {
  it('caches config, org tree, views and cost scope until invalidated', async () => {
    const h = await harness();
    const config = await h.app.getConfig();
    expect(await h.app.getConfig()).toBe(config);
    h.app.invalidateConfig();
    expect(await h.app.getConfig()).not.toBe(config);

    expect(await h.app.getOrgTreeConfig()).toBe(await h.app.getOrgTreeConfig());
    const views = await h.app.getViews();
    expect(await h.app.getViews()).toBe(views);
    h.app.invalidateViews();
    expect(await h.app.getViews()).not.toBe(views);

    const scope = await h.app.getCostScope();
    expect(scope.rules.some(r => r.builtIn)).toBe(true);
    expect(await h.app.getCostScope()).toBe(scope);
    h.app.invalidateCostScope();
    expect(h.app.state.costScope).toBeNull();
  });

  it('loads views and cost scope ungated when the dimensions config is broken', async () => {
    const h = await harness();
    await writeFile(h.ws.dimensionsPath, 'builtIn: 42\n');
    await expect(h.app.getDimensions()).rejects.toThrow('builtIn must be an array');
    expect((await h.app.getViews()).views.length).toBeGreaterThan(0);
    expect((await h.app.getCostScope()).rules.length).toBeGreaterThan(0);
  });

  it('reports no provider and no query sources while onboarding', async () => {
    const h = await harness({ config: 'none' });
    expect(await h.app.getFirstProviderName()).toBeNull();
    expect(await h.app.getQueryProviders('daily')).toEqual([]);
  });

  it('lists every provider with its own months per tier', async () => {
    const h = await harness({ config: 'multi', data: 'synthetic' });
    expect(await h.app.getFirstProviderName()).toBe(AWS);
    expect(await h.app.getQueryProviders('daily')).toEqual([
      { name: AWS, availablePeriods: ['2026-01', '2026-02'] },
      { name: FIXTURE_GCP_PROVIDER, availablePeriods: ['2026-01', '2026-02'] },
    ]);
    expect(await h.app.getQueryProviders('hourly')).toEqual([
      { name: AWS, availablePeriods: ['2026-02'] },
      { name: FIXTURE_GCP_PROVIDER, availablePeriods: [] },
    ]);
  });

  it('back-fills default built-in dimensions, except those every provider lacks', async () => {
    const fresh = await harness({ config: 'none' });
    await writeFile(fresh.ws.dimensionsPath, MINIMAL_DIMENSIONS());
    const freshNames = (await fresh.app.getDimensions()).builtIn.map(d => String(d.name));
    expect(freshNames).toEqual(expect.arrayContaining(['account', 'region', 'service', 'service_category']));

    const gcpOnly = await harness({ config: 'none' });
    await writeFile(gcpOnly.ws.configPath, configYaml(gcpProviderYaml('gcp-only')));
    await writeFile(gcpOnly.ws.dimensionsPath, MINIMAL_DIMENSIONS());
    const gcpNames = (await gcpOnly.app.getDimensions()).builtIn.map(d => String(d.name));
    expect(gcpNames).toContain('service');
    expect(gcpNames).not.toContain('service_category');
    expect(await gcpOnly.app.getDimensions()).toBe(await gcpOnly.app.getDimensions());
  });
});

describe('createAppContext: account and region names', () => {
  it('prefers the accounts CSV by default, falling back to org data', async () => {
    const h = await harness();
    expect(await h.app.getAccountMap()).toEqual(new Map());

    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify(ORG));
    h.app.state.accountMap = null;
    expect((await h.app.getAccountMap()).get('111111111111')).toBe('Payments Prod');

    // A raw/ dir with no accounts CSV still falls back to the org data.
    await mkdir(join(h.ws.stateDir, 'raw'));
    await writeFile(join(h.ws.stateDir, 'raw', 'notes.txt'), 'ignored');
    h.app.state.accountMap = null;
    expect((await h.app.getAccountMap()).get('111111111111')).toBe('Payments Prod');

    await writeFile(join(h.ws.stateDir, 'raw', 'Linked-Accounts.CSV'), [
      'Id,Arn,Path,Email,Name,Status',
      '"111111111111",arn,/Root,a@example.com,"From CSV",ACTIVE',
      '555555555555,arn,/Root,b@example.com,,ACTIVE',
      '888888888888,arn',
      '',
    ].join('\n'));
    h.app.state.accountMap = null;
    const fromCsv = await h.app.getAccountMap();
    expect(fromCsv).toEqual(new Map([['111111111111', 'From CSV']]));
    expect(await h.app.getAccountMap()).toBe(fromCsv);
  });

  it('prefers org data when the account dimension asks for it, applying its name rules', async () => {
    const h = await harness();
    await writeFile(h.ws.dimensionsPath, MINIMAL_DIMENSIONS([
      '    useOrgAccounts: true',
      '    accountNameFromTag: team',
      '    normalize: uppercase',
    ]));
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify(ORG));
    const map = await h.app.getAccountMap();
    expect(map).toEqual(new Map([['111111111111', 'PAYMENTS'], ['222222222222', 'DATA LAKE'], ['777777777777', 'NO OU']]));

    const reverse = await h.app.getAccountReverseMap();
    expect(reverse.get('PAYMENTS')).toEqual(['111111111111']);
    expect(await h.app.getAccountReverseMap()).toBe(reverse);
  });

  it('falls back to the CSV when org data is preferred but absent', async () => {
    const h = await harness();
    await writeFile(h.ws.dimensionsPath, MINIMAL_DIMENSIONS(['    useOrgAccounts: true']));
    await mkdir(join(h.ws.stateDir, 'raw'));
    await writeFile(join(h.ws.stateDir, 'raw', 'accounts.csv'), 'h\n666666666666,a,b,c,CSV Name\n');
    expect(await h.app.getAccountMap()).toEqual(new Map([['666666666666', 'CSV Name']]));
  });

  it('loads region friendly names and folds them into the query dimensions only', async () => {
    const h = await harness();
    expect(await h.app.getRegionMap()).toEqual(new Map());
    await writeFile(join(h.ws.stateDir, 'region-names.json'), JSON.stringify({
      syncedAt: '2026-02-20T00:00:00Z',
      regions: {
        'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' },
        'us-east-1': { longName: 'US East (N. Virginia)', country: 7 },
        'xx-none-1': { longName: '' },
        'xx-bad-1': 'not-a-record',
      },
    }));
    h.app.state.regionMap = null;
    const regions = await h.app.getRegionMap();
    expect(regions).toEqual(new Map([
      ['eu-central-1', { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' }],
      ['us-east-1', { longName: 'US East (N. Virginia)', country: '', continent: '' }],
    ]));
    expect(await h.app.getRegionMap()).toBe(regions);

    const raw = (await h.app.getDimensions()).builtIn.find(d => d.field === 'region');
    const enriched = (await h.app.getQueryDimensions()).builtIn.find(d => d.field === 'region');
    expect(JSON.stringify(raw?.aliases ?? {})).not.toContain('Frankfurt');
    expect(JSON.stringify(enriched?.aliases ?? {})).toContain('Europe (Frankfurt)');
  });

  it('treats a malformed region file as no names', async () => {
    const h = await harness();
    await writeFile(join(h.ws.stateDir, 'region-names.json'), JSON.stringify({ regions: ['eu-central-1'] }));
    expect(await h.app.getRegionMap()).toEqual(new Map());
  });
});

describe('createAppContext: flat org account-tags file', () => {
  const flat = (h: Harness): string => join(h.ws.stateDir, 'org-account-tags.json');

  it('generates it from org data with the OU path field, keeping only usable entries', async () => {
    const h = await harness();
    expect(await h.app.getOrgAccountsPath()).toBeUndefined();
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify(ORG));
    h.app.state.orgAccountsPath = null;
    expect(await h.app.getOrgAccountsPath()).toBe(flat(h));
    const written: unknown = JSON.parse(await readFile(flat(h), 'utf-8'));
    expect(written).toEqual([
      { id: '111111111111', tags: { team: 'payments' }, ouPath: '/Root/Payments' },
      { id: '222222222222', tags: { env: 'prod' }, ouPath: '' },
      { id: '777777777777', tags: {}, ouPath: '' },
    ]);
    expect(await h.app.getOrgAccountsPath()).toBe(flat(h));
  });

  it('keeps a current-schema file, and regenerates one written before the OU path field', async () => {
    const h = await harness();
    await writeFile(flat(h), '[]');
    expect(await h.app.getOrgAccountsPath()).toBe(flat(h));
    expect(await readFile(flat(h), 'utf-8')).toBe('[]');

    await writeFile(flat(h), JSON.stringify([{ id: '111111111111', tags: {} }]));
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify(ORG));
    h.app.state.orgAccountsPath = null;
    expect(await h.app.getOrgAccountsPath()).toBe(flat(h));
    expect(await readFile(flat(h), 'utf-8')).toContain('"ouPath"');
  });

  it('has no flat file to offer when the org data is unusable', async () => {
    const h = await harness();
    for (const content of ['{ broken', JSON.stringify({ accounts: {} }), JSON.stringify([1, 2])]) {
      await writeFile(join(h.ws.stateDir, 'org-accounts.json'), content);
      h.app.state.orgAccountsPath = null;
      expect(await h.app.getOrgAccountsPath()).toBeUndefined();
    }
  });
});

describe('createAppContext: query result cache', () => {
  it('caches non-empty results, shares concurrent identical queries, and never caches an empty result', async () => {
    const h = await harness({ config: 'none' });
    const sql = 'SELECT 42 AS answer';
    const [a, b] = await Promise.all([h.app.runQuery(sql), h.app.runQuery(sql)]);
    expect(a).toEqual([{ answer: 42 }]);
    expect(b).toBe(a);
    expect(await h.app.runQuery(sql)).toBe(a);
    expect(h.db.statements.filter(s => s === sql)).toHaveLength(1);

    const empty = 'SELECT 1 AS one WHERE false';
    await h.app.runQuery(empty);
    await h.app.runQuery(empty);
    expect(h.db.statements.filter(s => s === empty)).toHaveLength(2);
  });

  it('serves a repeated prepared query from the cache and logs it as a cached hit', async () => {
    const h = await harness({ config: 'none' });
    const sql = 'SELECT $1::INTEGER AS v';
    expect(await h.app.runPreparedQuery(sql, [7])).toEqual([{ v: 7 }]);
    expect(await h.app.runPreparedQuery(sql, [7], true)).toEqual([{ v: 7 }]);
    expect(await h.app.runPreparedQuery(sql, [8])).toEqual([{ v: 8 }]);
    expect(h.db.statements.filter(s => s === sql)).toHaveLength(2);
    const none = 'SELECT $1::INTEGER AS v WHERE false';
    await h.app.runPreparedQuery(none, [1]);
    await h.app.runPreparedQuery(none, [1]);
    expect(h.db.statements.filter(s => s === none)).toHaveLength(2);
    const entries = h.app.queryLog.getEntries();
    expect(entries.filter(e => e.cached)).toEqual([expect.objectContaining({ status: 'success', materialized: true, rowCount: 1 })]);
  });

  it('clearAllCaches cancels queries, drops every cache and re-warms', async () => {
    const h = await harness();
    await h.app.getConfig();
    await h.app.getDimensions();
    await h.app.getViews();
    await h.app.getCostScope();
    await h.app.getAccountMap();
    await h.app.getRegionMap();
    const sql = 'SELECT 1 AS one';
    await h.app.runQuery(sql);
    const invalidate = vi.spyOn(h.app.rollupStore, 'invalidate');

    await h.app.clearAllCaches();
    expect(h.db.cancelPendingQueries).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(h.app.state).toMatchObject({ config: null, dimensions: null, views: null, costScope: null, accountMap: null, regionMap: null, orgAccountsPath: null });
    await h.app.runQuery(sql);
    expect(h.db.statements.filter(s => s === sql)).toHaveLength(2);
    expect(await h.app.awaitWarmup(5_000)).toBe(false);
  });
});

describe('createAppContext: rollup lifecycle', () => {
  async function built(): Promise<Harness> {
    const h = await harness({ data: 'synthetic', rollupBuilds: true });
    h.app.warmupBase();
    expect(await h.app.awaitWarmup(10_000)).toBe(false);
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    await flush();
    return h;
  }

  function sidecarDir(h: Harness, name: ProviderName): Promise<string | undefined> {
    // A directory where the daily etag sidecar belongs makes it unreadable.
    return mkdir(providerEtagPath(h.ws.dataDir, name, 'daily'), { recursive: true });
  }

  it('settles without building when nothing is configured', async () => {
    const h = await harness({ config: 'none' });
    h.app.warmupBase();
    expect(await h.app.awaitWarmup(5_000)).toBe(false);
    expect(h.app.rollupStore.getStatus()).toEqual({ state: 'idle' });
    // Invalidating with no provider has no rollup tree to delete — and must not throw.
    h.app.invalidateCostScope();
    expect(await h.app.awaitWarmup(5_000)).toBe(false);
  });

  it('builds every local month in the background, then re-validates instead of rebuilding', async () => {
    const h = await built();
    expect([...h.app.rollupStore.getValidPeriods()].sort()).toEqual(['2026-01', '2026-02']);
    expect(await exists(join(h.ws.dataDir, AWS, 'rollup', 'daily-2026-02', 'rollup.parquet'))).toBe(true);
    const builds = h.db.statements.length;

    h.app.warmupBase();
    expect(await h.app.awaitWarmup(10_000)).toBe(true);
    expect(h.app.rollupStore.getStatus()).toEqual({ state: 'ready', periods: 2 });
    expect(h.db.statements.length).toBe(builds);
  });

  it('settles and logs when the sync state cannot be read', async () => {
    const h = await harness({ data: 'synthetic' });
    await sidecarDir(h, await firstProvider(h));
    const warn = vi.spyOn(logger, 'warn');
    h.app.warmupBase();
    expect(await h.app.awaitWarmup(5_000)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^rollup-warmup: Could not read the saved daily sync state/));
  });

  it('re-rolls only the changed months that exist locally, on a built rollup', async () => {
    const h = await built();
    const maintain = vi.spyOn(h.app.rollupStore, 'maintainPeriods');
    h.app.maintainRollup(['2026-02', '2025-06']);
    await vi.waitFor(() => { expect(maintain).toHaveBeenCalled(); });
    expect(maintain.mock.calls[0]?.[0]).toEqual(['2026-02']);
    expect(maintain.mock.calls[0]?.[4]).toEqual({ force: true });
    await settled(maintain.mock.results[0]?.value);
    expect(h.app.rollupStore.getStatus()).toEqual({ state: 'ready', periods: 2 });
  });

  it('loads the manifest first when a re-roll reaches a store that never warmed', async () => {
    const h = await harness({ data: 'synthetic', rollupBuilds: true });
    const load = vi.spyOn(h.app.rollupStore, 'loadAndValidate');
    const maintain = vi.spyOn(h.app.rollupStore, 'maintainPeriods');
    h.app.maintainRollup(['2026-01']);
    await vi.waitFor(() => { expect(maintain).toHaveBeenCalled(); });
    expect(load).toHaveBeenCalledTimes(1);
    await settled(maintain.mock.results[0]?.value);
    expect([...h.app.rollupStore.getValidPeriods()]).toEqual(['2026-01']);
  });

  it('skips a re-roll for months with no local data', async () => {
    const h = await harness({ data: 'synthetic' });
    const maintain = vi.spyOn(h.app.rollupStore, 'maintainPeriods');
    h.app.maintainRollup(['2025-06']);
    await vi.waitFor(() => { expect(listLocalMonths).toHaveBeenCalled(); });
    await settled(vi.mocked(listLocalMonths).mock.results[0]?.value);
    expect(maintain).not.toHaveBeenCalled();
  });

  it('skips a re-roll entirely while onboarding', async () => {
    const h = await harness({ config: 'none' });
    h.app.maintainRollup(['2026-01']);
    await vi.waitFor(() => { expect(loadConfig).toHaveBeenCalled(); });
    await settled(vi.mocked(loadConfig).mock.results[0]?.value);
    expect(listLocalMonths).not.toHaveBeenCalled();
  });

  it('drops raw results instead of building when an unwarmed store cannot read its sync state', async () => {
    const h = await harness({ data: 'synthetic' });
    await sidecarDir(h, await firstProvider(h));
    const warn = vi.spyOn(logger, 'warn');
    const maintain = vi.spyOn(h.app.rollupStore, 'maintainPeriods');
    h.app.maintainRollup(['2026-01']);
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^rollup-maintain: Could not read/)); });
    await flush();
    expect(maintain).not.toHaveBeenCalled();
  });

  it('rebuilds unverified when a built store cannot read its sync state', async () => {
    const h = await built();
    await sidecarDir(h, await firstProvider(h));
    const maintain = vi.spyOn(h.app.rollupStore, 'maintainPeriods');
    h.app.maintainRollup(['2026-01']);
    await vi.waitFor(() => { expect(maintain).toHaveBeenCalled(); });
    expect(maintain.mock.calls[0]?.[2]).toBeNull();
    await settled(maintain.mock.results[0]?.value);
  });

  it('logs a re-roll that fails part-way', async () => {
    const h = await harness({ data: 'synthetic' });
    await writeFile(h.ws.dimensionsPath, 'builtIn: 42\n');
    const warn = vi.spyOn(logger, 'warn');
    h.app.maintainRollup(['2026-01']);
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^rollup-maintain: /)); });
  });

  it('drops the rollup and re-warms when the cost scope changes', async () => {
    const h = await built();
    const invalidate = vi.spyOn(h.app.rollupStore, 'invalidate');
    const load = vi.spyOn(h.app.rollupStore, 'loadAndValidate');
    h.app.invalidateCostScope();
    expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => { expect(load).toHaveBeenCalled(); });
    // The warmup only launches the rebuild; the manifest lands once a
    // partition commits, so wait for the store to be ready again.
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    expect(await exists(join(h.ws.dataDir, AWS, 'rollup', 'manifest.json'))).toBe(true);
  });

  it('coalesces a burst of dimension edits into one re-roll', async () => {
    const h = await harness({ data: 'synthetic' });
    await h.app.getAccountMap();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const invalidate = vi.spyOn(h.app.rollupStore, 'invalidate');
    const load = vi.spyOn(h.app.rollupStore, 'loadAndValidate');
    h.app.invalidateDimensions();
    h.app.invalidateDimensions();
    expect(h.app.state).toMatchObject({ dimensions: null, accountMap: null, accountReverseMap: null, regionMap: null, orgAccountsPath: null });
    expect(invalidate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(800);
    vi.useRealTimers();
    await h.app.awaitWarmup(10_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('clearAllCaches deletes the built rollup tree of the provider configured at the time', async () => {
    const h = await built();
    const rollupDir = join(h.ws.dataDir, AWS, 'rollup');
    expect(await exists(rollupDir)).toBe(true);
    await h.app.clearAllCaches();
    expect(await exists(join(rollupDir, 'daily-2026-01'))).toBe(false);
  });

  it('signs the rollup shape with the org data, tolerating an unreadable cost scope', async () => {
    const h = await harness();
    const dims = await h.app.getDimensions();
    const before = await h.app.signatureForDimensions(dims);
    expect(await h.app.signatureForDimensions(dims)).toBe(before);
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), JSON.stringify(ORG));
    expect(await h.app.signatureForDimensions(dims)).not.toBe(before);
    await writeFile(h.ws.costScopePath, 'rules: 42\n');
    h.app.state.costScope = null;
    expect(await h.app.signatureForDimensions(dims)).toMatch(/\S/);
  });

  it('recomputeBaselines hands the store its engine dependencies', async () => {
    const h = await harness();
    const recompute = vi.spyOn(h.app.baselineStore, 'recompute').mockResolvedValue(undefined);
    h.app.recomputeBaselines();
    expect(recompute).toHaveBeenCalledWith(h.app.baselineEngineDeps);
  });
});
