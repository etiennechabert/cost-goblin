import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncOrgAccounts, type OrgSyncProgress, type OrgSyncResult } from '../main/aws-org-client.js';
import { syncRegionNames } from '../main/aws-ssm-client.js';
import { registerOrgHandlers } from '../main/handlers/org.js';
import { FIXTURE_AWS_PROVIDER, at, createHarness, type FixtureConfigSet, type Harness } from './helpers/ipc-harness.js';

/** AWS Organizations + SSM region-name sync, as the Org view drives it: the
 *  per-provider sidecar / legacy single-file write, the flat tag lookup, the
 *  non-fatal region step and its remembered error, progress polling, and
 *  clearing everything the sync produced. Only the two AWS clients are fake. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('../main/aws-org-client.js', () => ({ syncOrgAccounts: vi.fn() }));
vi.mock('../main/aws-ssm-client.js', () => ({ syncRegionNames: vi.fn() }));

const harnesses: Harness[] = [];

beforeEach(() => {
  vi.mocked(syncOrgAccounts).mockReset();
  vi.mocked(syncRegionNames).mockReset();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function orgApp(config: FixtureConfigSet = 'single'): Promise<Harness> {
  const h = await createHarness({ config });
  registerOrgHandlers(h.app);
  harnesses.push(h);
  return h;
}

const RESULT: OrgSyncResult = {
  orgId: 'o-abc123',
  syncedAt: '2026-02-20T00:00:00.000Z',
  accounts: [
    { id: '111111111111', name: 'Payments Prod', email: 'p@example.com', status: 'ACTIVE', joinedTimestamp: '2024-01-01T00:00:00Z', ouPath: '/Root/Payments', tags: { team: 'payments' } },
  ],
};

const REGIONS = {
  syncedAt: '2026-02-20T01:00:00.000Z',
  regions: { 'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' } },
};

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

describe('org:sync-accounts', () => {
  it('stores the first provider\'s result as a sidecar plus the merged view, with the flat tags and region names', async () => {
    const h = await orgApp();
    vi.mocked(syncOrgAccounts).mockResolvedValueOnce(RESULT);
    vi.mocked(syncRegionNames).mockResolvedValueOnce(REGIONS);
    expect(await h.ipc.invoke('org:sync-accounts', 'org-reader')).toEqual(RESULT);
    expect(syncOrgAccounts).toHaveBeenCalledWith('org-reader', expect.any(Function));
    expect(syncRegionNames).toHaveBeenCalledWith('org-reader');

    const files = await readdir(h.ws.stateDir);
    expect(files).toEqual(expect.arrayContaining(['org-accounts.json', 'org-account-tags.json', 'region-names.json']));
    expect(files.some(f => f !== 'org-accounts.json' && f.startsWith('org-accounts') && f.includes(FIXTURE_AWS_PROVIDER))).toBe(true);
    expect(at(await json(join(h.ws.stateDir, 'org-accounts.json')), 'accounts', 0, 'id')).toBe('111111111111');
    expect(await json(join(h.ws.stateDir, 'org-account-tags.json'))).toEqual([{ id: '111111111111', tags: { team: 'payments' }, ouPath: '/Root/Payments' }]);
    expect(await json(join(h.ws.stateDir, 'region-names.json'))).toEqual(REGIONS);
    expect(await h.ipc.invoke('org:get-progress')).toBeNull();
  });

  it('writes the legacy single file while no provider is configured', async () => {
    const h = await orgApp('none');
    vi.mocked(syncOrgAccounts).mockResolvedValueOnce(RESULT);
    vi.mocked(syncRegionNames).mockResolvedValueOnce(REGIONS);
    await h.ipc.invoke('org:sync-accounts', 'default');
    expect((await readdir(h.ws.stateDir)).sort()).toEqual(['org-account-tags.json', 'org-accounts.json', 'region-names.json']);
    expect(await json(join(h.ws.stateDir, 'org-accounts.json'))).toEqual(RESULT);
    expect(await h.ipc.invoke('org:get-result')).toEqual(RESULT);
  });

  it('targets a named provider, and refuses an unknown one before syncing', async () => {
    const h = await orgApp('multi');
    vi.mocked(syncOrgAccounts).mockResolvedValueOnce(RESULT);
    vi.mocked(syncRegionNames).mockResolvedValueOnce(REGIONS);
    await h.ipc.invoke('org:sync-accounts', 'p', FIXTURE_AWS_PROVIDER);
    expect(at(await h.ipc.invoke('org:get-result'), 'orgId')).toBe('o-abc123');

    await expect(h.ipc.invoke('org:sync-accounts', 'p', 'nope')).rejects.toThrow('Unknown provider "nope"');
    expect(syncOrgAccounts).toHaveBeenCalledTimes(1);

    const none = await orgApp('none');
    await expect(none.ipc.invoke('org:sync-accounts', 'p', 'aws-main')).rejects.toThrow('Unknown provider "aws-main"');
  });

  it('reports progress while the sync runs', async () => {
    const h = await orgApp();
    const seen: unknown[] = [];
    vi.mocked(syncOrgAccounts).mockImplementationOnce(async (_profile, onProgress?: (p: OrgSyncProgress) => void) => {
      seen.push(await h.ipc.invoke('org:get-progress'));
      onProgress?.({ phase: 'tags', done: 3, total: 9 });
      seen.push(await h.ipc.invoke('org:get-progress'));
      return RESULT;
    });
    vi.mocked(syncRegionNames).mockImplementationOnce(async () => {
      seen.push(await h.ipc.invoke('org:get-progress'));
      return REGIONS;
    });
    await h.ipc.invoke('org:sync-accounts', 'p');
    expect(seen).toEqual([
      { phase: 'accounts', done: 0, total: 0 },
      { phase: 'tags', done: 3, total: 9 },
      { phase: 'regions', done: 0, total: 0 },
    ]);
  });

  it('keeps the org data when the region step fails, and remembers why', async () => {
    const h = await orgApp();
    vi.mocked(syncOrgAccounts).mockResolvedValue(RESULT);
    vi.mocked(syncRegionNames).mockRejectedValueOnce(new Error('AccessDeniedException: ssm:GetParametersByPath'));
    expect(await h.ipc.invoke('org:sync-accounts', 'p')).toEqual(RESULT);
    expect(await h.ipc.invoke('org:get-region-names-info')).toEqual({
      count: 0, syncedAt: '', lastError: 'AccessDeniedException: ssm:GetParametersByPath', regions: {},
    });

    vi.mocked(syncRegionNames).mockRejectedValueOnce('throttled');
    await h.ipc.invoke('org:sync-accounts', 'p');
    expect(at(await h.ipc.invoke('org:get-region-names-info'), 'lastError')).toBe('throttled');
  });

  it('resets progress and rethrows when the org sync fails', async () => {
    const h = await orgApp();
    vi.mocked(syncOrgAccounts).mockRejectedValueOnce(new Error('AWSOrganizationsNotInUseException'));
    await expect(h.ipc.invoke('org:sync-accounts', 'p')).rejects.toThrow('AWSOrganizationsNotInUseException');
    expect(await h.ipc.invoke('org:get-progress')).toBeNull();
    expect(syncRegionNames).not.toHaveBeenCalled();
  });
});

describe('org:get-result', () => {
  it('is null with no sync yet, or when the file does not decode', async () => {
    const h = await orgApp();
    expect(await h.ipc.invoke('org:get-result')).toBeNull();
    await writeFile(join(h.ws.stateDir, 'org-accounts.json'), '{ not json');
    expect(await h.ipc.invoke('org:get-result')).toBeNull();
  });
});

describe('ssm:sync-region-names', () => {
  it('syncs region names on their own and refreshes the dimension caches', async () => {
    const h = await orgApp();
    await h.app.getDimensions();
    vi.mocked(syncRegionNames).mockResolvedValueOnce(REGIONS);
    expect(await h.ipc.invoke('ssm:sync-region-names', 'p')).toEqual({ count: 1, syncedAt: REGIONS.syncedAt });
    expect(await json(join(h.ws.stateDir, 'region-names.json'))).toEqual(REGIONS);
    expect(h.app.state.dimensions).toBeNull();
    expect(await h.ipc.invoke('org:get-progress')).toBeNull();
  });

  it('records the failure for the info panel and rethrows', async () => {
    const h = await orgApp();
    vi.mocked(syncRegionNames).mockRejectedValueOnce(new Error('ExpiredToken'));
    await expect(h.ipc.invoke('ssm:sync-region-names', 'p')).rejects.toThrow('ExpiredToken');
    expect(await h.ipc.invoke('org:get-progress')).toBeNull();
    expect(at(await h.ipc.invoke('org:get-region-names-info'), 'lastError')).toBe('ExpiredToken');

    vi.mocked(syncRegionNames).mockRejectedValueOnce(503);
    await expect(h.ipc.invoke('ssm:sync-region-names', 'p')).rejects.toBe(503);
    expect(at(await h.ipc.invoke('org:get-region-names-info'), 'lastError')).toBe('503');

    // A later success clears the remembered error.
    vi.mocked(syncRegionNames).mockResolvedValueOnce(REGIONS);
    await h.ipc.invoke('ssm:sync-region-names', 'p');
    expect(at(await h.ipc.invoke('org:get-region-names-info'), 'lastError')).toBeNull();
  });
});

describe('org:get-region-names-info', () => {
  it('is null with no file and no remembered error', async () => {
    const h = await orgApp();
    expect(await h.ipc.invoke('org:get-region-names-info')).toBeNull();
  });

  it('lists the usable regions of the file', async () => {
    const h = await orgApp();
    await writeFile(join(h.ws.stateDir, 'region-names.json'), JSON.stringify({
      syncedAt: '2026-02-20T00:00:00Z',
      regions: {
        'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' },
        'us-east-1': { longName: 'US East', country: null, continent: 1 },
        'xx-empty-1': { longName: '' },
        'xx-bad-1': 'nope',
      },
    }));
    expect(await h.ipc.invoke('org:get-region-names-info')).toEqual({
      count: 2,
      syncedAt: '2026-02-20T00:00:00Z',
      lastError: null,
      regions: {
        'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' },
        'us-east-1': { longName: 'US East', country: '', continent: '' },
      },
    });
  });

  it('is null for a file of the wrong shape', async () => {
    const h = await orgApp();
    const file = join(h.ws.stateDir, 'region-names.json');
    for (const content of ['[1]', JSON.stringify({ syncedAt: 1, regions: {} }), JSON.stringify({ syncedAt: 'x', regions: [] })]) {
      await writeFile(file, content);
      expect(await h.ipc.invoke('org:get-region-names-info')).toBeNull();
    }
  });
});

describe('org:clear-data', () => {
  it('deletes everything the sync produced, idempotently, and refreshes caches', async () => {
    const h = await orgApp();
    vi.mocked(syncOrgAccounts).mockResolvedValueOnce(RESULT);
    vi.mocked(syncRegionNames).mockRejectedValueOnce(new Error('denied'));
    await h.ipc.invoke('org:sync-accounts', 'p');
    await writeFile(join(h.ws.stateDir, 'region-names.json'), JSON.stringify(REGIONS));
    await writeFile(join(h.ws.stateDir, 'unrelated.json'), '{}');
    await h.app.getDimensions();

    await h.ipc.invoke('org:clear-data');
    expect(await readdir(h.ws.stateDir)).toEqual(['unrelated.json']);
    expect(h.app.state.dimensions).toBeNull();
    // The remembered region error went with the data.
    expect(await h.ipc.invoke('org:get-region-names-info')).toBeNull();
    await expect(h.ipc.invoke('org:clear-data')).resolves.toBeUndefined();
  });

  it('keeps going past a file it cannot delete', async () => {
    const h = await orgApp();
    await mkdir(join(h.ws.stateDir, 'region-names.json'));
    await mkdir(join(h.ws.stateDir, 'org-accounts.json'));
    await writeFile(join(h.ws.stateDir, 'org-account-tags.json'), '[]');
    await h.ipc.invoke('org:clear-data');
    expect((await readdir(h.ws.stateDir)).sort()).toEqual(['org-accounts.json', 'region-names.json']);
  });
});
