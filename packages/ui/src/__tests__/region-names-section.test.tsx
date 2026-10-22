import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CostApi } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { SsmParameterSection } from '../views/data-management-ssm.js';
import { deferred } from './deferred.js';

type RegionInfo = Awaited<ReturnType<CostApi['getRegionNamesInfo']>>;

const CACHED: NonNullable<RegionInfo> = {
  count: 3,
  syncedAt: '2026-10-01T08:00:00Z',
  lastError: null,
  regions: {
    // SSM's geolocationRegion, stored as `continent`: an ISO 3166-2 subdivision.
    'us-east-1': { longName: 'US East (N. Virginia)', country: 'US', continent: 'US-VA' },
    'eu-west-1': { longName: 'Europe (Ireland)', country: 'IE', continent: 'IE-D' },
    'il-central-1': { longName: 'Israel (Tel Aviv)', country: '', continent: '' },
  },
};

/** A mock whose region-name cache answers each read in turn: the first
 *  `infos` entry on mount, the next after a sync or clear re-reads it, and
 *  the last one from then on. */
class RegionApi extends MockCostApi {
  reads = 0;
  private readonly infos: readonly RegionInfo[];
  constructor(infos: readonly RegionInfo[]) {
    super();
    this.infos = infos;
  }
  override getRegionNamesInfo(): ReturnType<CostApi['getRegionNamesInfo']> {
    const info = this.infos[Math.min(this.reads, this.infos.length - 1)] ?? null;
    this.reads += 1;
    return Promise.resolve(info);
  }
}

function renderSection(api: CostApi, profile: string | null = 'default') {
  const user = userEvent.setup();
  const view = render(
    <CostApiProvider value={api}>
      <SsmParameterSection profile={profile} />
    </CostApiProvider>,
  );
  return { user, ...view };
}

function regionCodes(): string[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1).map(r => r.querySelector('td')?.textContent ?? '');
}

afterEach(cleanup);

describe('SsmParameterSection — nothing cached', () => {
  it('renders nothing without an AWS profile, since SSM only names AWS regions', async () => {
    const api = new RegionApi([null]);
    const { container } = renderSection(api, null);
    await waitFor(() => { expect(api.reads).toBe(1); });
    expect(container.childElementCount).toBe(0);
  });

  it('offers the sync, shows it running, then lists the synced names', async () => {
    const api = new RegionApi([null, CACHED]);
    const pending = deferred<{ count: number; syncedAt: string }>();
    const sync = vi.spyOn(api, 'syncRegionNames').mockReturnValue(pending.promise);
    const { user } = renderSection(api, 'prod');

    expect(await screen.findByText('Region Names not synced')).toBeDefined();
    expect(screen.getByText(/Sync region friendly names from SSM/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Sync region names' }));
    expect(sync).toHaveBeenCalledWith('prod');
    expect(screen.getByText('Fetching region friendly names…')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Sync region names' })).toBeNull();

    pending.resolve({ count: 3, syncedAt: CACHED.syncedAt });
    expect(await screen.findByText('3 regions enriched with longName + country + subdivision')).toBeDefined();
  });

  it('shows the last SSM failure, and re-reads the cache after a retry fails too', async () => {
    const failed: RegionInfo = { count: 0, syncedAt: '', lastError: 'AccessDeniedException: ssm:GetParametersByPath', regions: {} };
    const api = new RegionApi([failed]);
    vi.spyOn(api, 'syncRegionNames').mockRejectedValue(new Error('still denied'));
    const { user } = renderSection(api);

    expect(await screen.findByText('Region Names sync failed')).toBeDefined();
    expect(screen.getByText('AccessDeniedException: ssm:GetParametersByPath')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Retry sync' }));
    await waitFor(() => { expect(api.reads).toBe(2); });
    expect(screen.getByRole('button', { name: 'Retry sync' })).toBeDefined();
  });

  it('recovers from a sync that rejects with something other than an Error', async () => {
    const api = new RegionApi([null]);
    vi.spyOn(api, 'syncRegionNames').mockRejectedValue('timeout');
    const { user } = renderSection(api);
    await user.click(await screen.findByRole('button', { name: 'Sync region names' }));
    await waitFor(() => { expect(api.reads).toBe(2); });
    expect(screen.getByRole('button', { name: 'Sync region names' })).toBeDefined();
  });
});

describe('SsmParameterSection — cached names', () => {
  it('summarizes the cache collapsed, with when it was synced', async () => {
    const { user } = renderSection(new RegionApi([CACHED]));
    const toggle = await screen.findByRole('button', { name: /^Region Names/ });
    expect(toggle.textContent).toContain('▸');
    expect(screen.getByText('3 regions enriched with longName + country + subdivision')).toBeDefined();
    expect(screen.getByText(`Synced ${new Date('2026-10-01T08:00:00Z').toLocaleString()}`)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();

    await user.click(toggle);
    expect(toggle.textContent).toContain('▾');
    expect(screen.getByText('From /aws/service/global-infrastructure/regions')).toBeDefined();
    expect(regionCodes()).toEqual(['eu-west-1', 'il-central-1', 'us-east-1']);
    // A region SSM gives no geolocation for shows dashes, not blanks.
    const israel = within(screen.getByRole('table')).getByText('il-central-1').closest('tr');
    if (israel === null) throw new Error('row missing');
    expect(within(israel).getAllByText('—')).toHaveLength(2);

    await user.click(toggle);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('omits the synced time when the cache carries none', async () => {
    renderSection(new RegionApi([{ ...CACHED, count: 1, syncedAt: '' }]));
    expect(await screen.findByText('1 regions enriched with longName + country + subdivision')).toBeDefined();
    expect(screen.queryByText(/^Synced /)).toBeNull();
  });

  it.each([
    { search: 'EU-WEST', expected: ['eu-west-1'], by: 'code' },
    { search: 'virginia', expected: ['us-east-1'], by: 'friendly name' },
    { search: 'ie', expected: ['eu-west-1'], by: 'country' },
    { search: 'us-va', expected: ['us-east-1'], by: 'subdivision' },
  ])('filters the table by $by', async ({ search, expected }) => {
    const { user } = renderSection(new RegionApi([CACHED]));
    await user.click(await screen.findByRole('button', { name: /^Region Names/ }));
    await user.type(screen.getByPlaceholderText('Search regions...'), search);
    expect(regionCodes()).toEqual(expected);
  });

  it('re-syncs with the profile, disabling both actions while it runs', async () => {
    const api = new RegionApi([CACHED, { ...CACHED, count: 4 }]);
    const pending = deferred<{ count: number; syncedAt: string }>();
    vi.spyOn(api, 'syncRegionNames').mockReturnValue(pending.promise);
    const { user } = renderSection(api);

    const resync = await screen.findByRole('button', { name: 'Re-sync' });
    await user.click(resync);
    expect(resync).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Fetching region friendly names…')).toBeDefined();

    pending.resolve({ count: 4, syncedAt: '2026-10-02T08:00:00Z' });
    expect(await screen.findByText('4 regions enriched with longName + country + subdivision')).toBeDefined();
    expect(resync).toHaveProperty('disabled', false);
  });

  it('keeps names cached by a removed AWS provider listed, with Clear but no Re-sync', async () => {
    renderSection(new RegionApi([CACHED]), null);
    expect(await screen.findByRole('button', { name: 'Clear' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Re-sync' })).toBeNull();
  });

  it('asks before clearing, and re-reads the emptied cache once cleared', async () => {
    const api = new RegionApi([CACHED, null]);
    const clear = vi.spyOn(api, 'clearOrgData');
    const { user } = renderSection(api);

    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Clear cached region names? Re-sync any time to repopulate.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Clear cached region names\?/)).toBeNull();
    expect(clear).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    const buttons = screen.getAllByRole('button', { name: 'Clear' });
    const confirm = buttons.at(-1);
    if (confirm === undefined) throw new Error('confirm button missing');
    await user.click(confirm);
    expect(clear).toHaveBeenCalledTimes(1);
    // The cache is gone, so the section falls back to offering a sync.
    expect(await screen.findByText('Region Names not synced')).toBeDefined();
  });
});
