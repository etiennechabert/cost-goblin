import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CostApi, OrgAccount, OrgSyncResult } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The two collapsed "Debug info" panels under the Dimensions view: the
 *  resource tag keys found by scanning billing data, and the account-level
 *  tags from the AWS Organization sync, each as a pivot table whose columns
 *  can be hidden. */

type TagScan = Awaited<ReturnType<CostApi['discoverTagKeys']>>;

function account(id: string, tags: Readonly<Record<string, string>>): OrgAccount {
  return { id, name: `acct-${id}`, email: `${id}@example.com`, status: 'ACTIVE', joinedTimestamp: '2024-01-01T00:00:00Z', ouPath: 'Root', tags };
}

const ORG: OrgSyncResult = {
  orgId: 'o-example',
  syncedAt: '2026-04-30T00:00:00Z',
  accounts: [
    account('1', { team: 'payments', CostCenter: 'cc-1' }),
    account('2', { team: 'payments', CostCenter: '' }),
    account('3', { team: 'search' }),
  ],
};

function renderView(setup: { org?: OrgSyncResult | null; scan?: () => Promise<TagScan> } = {}) {
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getOrgSyncResult').mockResolvedValue(setup.org ?? null);
  const scan = setup.scan;
  const discover = scan === undefined ? vi.spyOn(api, 'discoverTagKeys') : vi.spyOn(api, 'discoverTagKeys').mockImplementation(scan);
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { discover, user };
}

/** A panel's toggle and the container its content renders into. */
async function panel(title: 'Resource Tags' | 'Account Tags'): Promise<{ toggle: HTMLElement; body: HTMLElement }> {
  const toggle = await screen.findByRole('button', { name: new RegExp(title) });
  const body = toggle.parentElement;
  if (body === null) throw new Error(`${title} panel has no container`);
  return { toggle, body };
}

function headers(body: HTMLElement): string[] {
  return within(body).queryAllByRole('columnheader').map(th => th.querySelector('span')?.textContent ?? '');
}

function cells(body: HTMLElement): string[][] {
  return within(body).getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell').map(c => c.textContent));
}

/** The column toggles, in the order they are listed (after the panel's own
 *  expand button). */
function toggles(body: HTMLElement): string[] {
  return within(body).getAllByRole('button').slice(1).map(b => b.textContent);
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('Account Tags panel', () => {
  it('explains that it needs an Organization sync', async () => {
    const { user } = renderView({ org: null });
    const { toggle, body } = await panel('Account Tags');
    expect(toggle.textContent).toContain('Requires an AWS Organization sync');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(body).getByText(/No Organization sync data yet/)).toBeDefined();

    await user.click(toggle);
    expect(within(body).queryByText(/No Organization sync data yet/)).toBeNull();
  });

  it('says when the synced accounts carry no tags', async () => {
    const { user } = renderView({ org: { ...ORG, accounts: [account('1', {}), account('2', {})] } });
    const { toggle, body } = await panel('Account Tags');
    await waitFor(() => { expect(toggle.textContent).toContain('0 keys · across 2 accounts'); });
    await user.click(toggle);
    expect(within(body).getByText('No tags found on any accounts.')).toBeDefined();
  });

  it('pivots each tag key into a column of its values, most common first', async () => {
    const { user } = renderView({ org: ORG });
    const { toggle, body } = await panel('Account Tags');
    await waitFor(() => { expect(toggle.textContent).toContain('2 keys · across 3 accounts'); });
    await user.click(toggle);

    expect(headers(body)).toEqual(['CostCenter', 'team']);
    // An empty value doesn't count as tagged.
    expect(within(body).getByText('1/3 accts')).toBeDefined();
    expect(within(body).getByText('3/3 accts')).toBeDefined();
    expect(cells(body)).toEqual([['cc-1 (1)', 'payments (2)'], ['', 'search (1)']]);
  });

  it('hides a column, listing its key last, and shows it again', async () => {
    const { user } = renderView({ org: ORG });
    const { toggle, body } = await panel('Account Tags');
    await waitFor(() => { expect(toggle.textContent).toContain('2 keys'); });
    await user.click(toggle);

    await user.click(within(body).getByRole('button', { name: 'CostCenter' }));
    expect(headers(body)).toEqual(['team']);
    expect(within(body).getByRole('button', { name: 'CostCenter' }).getAttribute('aria-pressed')).toBe('false');
    expect(toggles(body)).toEqual(['team', 'CostCenter']);

    // With every column hidden there is no table at all.
    await user.click(within(body).getByRole('button', { name: 'team' }));
    expect(within(body).queryByRole('table')).toBeNull();

    await user.click(within(body).getByRole('button', { name: 'CostCenter' }));
    expect(headers(body)).toEqual(['CostCenter']);
  });
});

describe('Resource Tags panel', () => {
  const SCAN: TagScan = {
    tags: [
      { key: 'team', sampleValues: ['payments', 'search', 'platform'], rowCount: 500, distinctCount: 3, coveragePct: 45 },
      { key: 'env', sampleValues: ['prod'], rowCount: 400, distinctCount: 1, coveragePct: 36 },
    ],
    samplePeriod: '',
  };

  it('scans only once expanded, showing progress while it runs', async () => {
    let finish: (scan: TagScan) => void = () => undefined;
    const { discover, user } = renderView({ scan: () => new Promise<TagScan>((resolve) => { finish = resolve; }) });
    const { toggle, body } = await panel('Resource Tags');
    expect(toggle.textContent).toContain('Tag keys discovered by scanning the latest billing period');
    expect(discover).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(await within(body).findByText('Scanning billing data for tags...')).toBeDefined();
    expect(discover).toHaveBeenCalledTimes(1);

    await act(async () => { finish(SCAN); await Promise.resolve(); });
    await waitFor(() => { expect(headers(body)).toEqual(['team', 'env']); });
    // No sample period: the subtitle names only the key count.
    expect(toggle.textContent).toContain('2 keys');
    expect(toggle.textContent).not.toContain('sampled from');
    // Shorter columns pad with blanks.
    expect(cells(body)).toEqual([['payments', 'prod'], ['search', ''], ['platform', '']]);
  });

  it('shows why the scan failed', async () => {
    const { user } = renderView({ scan: () => Promise.reject(new Error('No billing data synced yet')) });
    const { toggle, body } = await panel('Resource Tags');
    await user.click(toggle);
    expect(await within(body).findByText('No billing data synced yet')).toBeDefined();
    expect(within(body).queryByRole('table')).toBeNull();
  });

  it('shows nothing when the scan finds no tags', async () => {
    const { user } = renderView({ scan: () => Promise.resolve({ tags: [], samplePeriod: '2026-04' }) });
    const { toggle, body } = await panel('Resource Tags');
    await user.click(toggle);
    await waitFor(() => { expect(toggle.textContent).toContain('0 keys · sampled from 2026-04'); });
    expect(within(body).queryAllByRole('button')).toHaveLength(1);
  });

  it('hides a column, listing its key last, and shows it again', async () => {
    const owner = { key: 'owner', sampleValues: ['alice'], rowCount: 50, distinctCount: 1, coveragePct: 5 };
    const { user } = renderView({ scan: () => Promise.resolve({ ...SCAN, tags: [...SCAN.tags, owner] }) });
    const { toggle, body } = await panel('Resource Tags');
    await user.click(toggle);
    await waitFor(() => { expect(headers(body)).toEqual(['team', 'env', 'owner']); });

    await user.click(within(body).getByRole('button', { name: 'env' }));
    expect(headers(body)).toEqual(['team', 'owner']);
    expect(toggles(body)).toEqual(['team', 'owner', 'env']);
    expect(within(body).getByRole('button', { name: 'env' }).getAttribute('aria-pressed')).toBe('false');

    // Hidden keys keep their scan order behind the shown ones.
    await user.click(within(body).getByRole('button', { name: 'team' }));
    expect(toggles(body)).toEqual(['owner', 'team', 'env']);

    await user.click(within(body).getByRole('button', { name: 'env' }));
    await user.click(within(body).getByRole('button', { name: 'team' }));
    expect(headers(body)).toEqual(['team', 'env', 'owner']);
  });
});
