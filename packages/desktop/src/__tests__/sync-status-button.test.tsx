import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND } from '@costgoblin/core/browser';
import type { SyncStatus } from '@costgoblin/core/browser';
import { CostApiProvider, MockCostApi } from '@costgoblin/ui';
import { SyncStatusButton } from '../renderer/top-menu/sync-status-button.js';
import type { SyncTier } from '../renderer/top-menu/sync-status-button.js';

type Props = Parameters<typeof SyncStatusButton>[0];

const DEFAULTS: Props = {
  activity: 'idle',
  error: null,
  filesRemaining: 0,
  missingPeriods: 0,
  currentMonthUpdating: false,
  tiers: [],
  inSettingsData: false,
  onManageData: () => undefined,
  onRecheck: () => Promise.resolve(),
};

function renderButton(props: Partial<Props> = {}, api: MockCostApi = new MockCostApi()): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <SyncStatusButton {...DEFAULTS} {...props} />
    </CostApiProvider>,
  );
  return user;
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Data sync' });
}

/** The trigger's corner badge text, or null when it shows none. */
function badge(): string | null {
  const spans = trigger().querySelectorAll('span');
  return spans.length === 0 ? null : (spans[0]?.textContent ?? null);
}

async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger());
  return screen.findByRole('dialog');
}

function syncing(fields: Partial<Extract<SyncStatus, { status: 'syncing' }>> = {}): SyncStatus {
  return { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: 10, filesDone: 3, bytesTotal: 0, bytesDone: 0, message: '', ...fields };
}

function tier(id: string, label: string, status: SyncStatus): SyncTier {
  return { id, label, status };
}

/** A tier row's progress-bar width, or null when the row shows no bar. */
function barWidth(row: HTMLElement): string | null {
  const bar = row.querySelector<HTMLElement>('[style]');
  return bar === null ? null : bar.style.width;
}

/** The row for a tier label inside the open popover: label → its line → row. */
function tierRow(popover: HTMLElement, label: string): HTMLElement {
  const row = within(popover).getByText(label).parentElement?.parentElement;
  if (row === null || row === undefined) throw new Error(`no row for ${label}`);
  return row;
}

describe('SyncStatusButton — the header indicator', () => {
  it.each([
    { name: 'nothing to report', props: {}, badge: null },
    { name: 'a sync error', props: { error: 'Network down' }, badge: '!' },
    { name: 'an error even while downloading', props: { error: 'Network down', activity: 'downloading' as const, filesRemaining: 4 }, badge: '!' },
    { name: 'a download with files left', props: { activity: 'downloading' as const, filesRemaining: 4 }, badge: '4' },
    { name: 'periods not synced', props: { missingPeriods: 3 }, badge: '3' },
    { name: 'one period not synced', props: { missingPeriods: 1 }, badge: '1' },
    { name: 'missing periods while Data & Sync is open', props: { missingPeriods: 3, inSettingsData: true }, badge: null },
    { name: 'only the current month updating', props: { currentMonthUpdating: true }, badge: null },
  ])('shows $name, with no native title', ({ props, badge: expected }) => {
    renderButton(props);
    expect(trigger().getAttribute('title')).toBeNull();
    expect(badge()).toBe(expected);
  });

  it('pulses a dot instead of a count while checking with no files queued', () => {
    renderButton({ activity: 'syncing', filesRemaining: 0, missingPeriods: 2 });
    const dot = trigger().querySelector('span');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(dot?.textContent).toBe('');
  });

  it.each([
    { name: 'nothing to report', props: {} },
    { name: 'a sync error', props: { error: 'Network down' } },
  ])('explains itself on hover with $name, leaving the status to the popover', async ({ props }) => {
    const user = renderButton(props);
    await user.hover(trigger());
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Data sync')).toBeDefined();
    expect(within(tip).getByText('Billing data downloads')).toBeDefined();
    expect(within(tip).queryByText(/Network down/)).toBeNull();
  });

  it('hides the tooltip while its popover is open, and points the popover at the button', async () => {
    const user = renderButton();
    await user.hover(trigger());
    const popover = await openPopover(user);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(trigger());
    await user.hover(trigger());
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(popover.querySelector('[data-card-arrow]')).not.toBeNull();
  });
});

describe('SyncStatusButton — the popover', () => {
  it('breaks progress down per tier', async () => {
    const lastSync = new Date(Date.now() - 5 * 60_000);
    const user = renderButton({
      activity: 'downloading',
      filesRemaining: 7,
      tiers: [
        tier('daily', 'Daily', syncing({ bytesTotal: 200, bytesDone: 50 })),
        tier('hourly', 'Hourly', { status: 'completed', lastSync, filesDownloaded: 4 }),
        tier('cost-optimization', 'Cost optimization', { status: 'failed', error: new Error('denied'), lastSync: null }),
      ],
    });
    const popover = await openPopover(user);

    const daily = tierRow(popover, 'Daily');
    expect(within(daily).getByText('3/10 files')).toBeDefined();
    // Progress follows bytes when the size is known.
    expect(barWidth(daily)).toBe('25%');

    const hourly = tierRow(popover, 'Hourly');
    expect(within(hourly).getByText('synced')).toBeDefined();
    const ago = within(hourly).getByText('· 5m ago');
    expect(ago.getAttribute('title')).toBe(lastSync.toLocaleString());
    expect(barWidth(hourly)).toBeNull();

    const costOpt = tierRow(popover, 'Cost optimization');
    expect(within(costOpt).getByText('failed')).toBeDefined();
    expect(within(costOpt).queryByText(/ago$/)).toBeNull();
  });

  it.each([
    { name: 'file counts when byte sizes are unknown', status: syncing({ filesTotal: 4, filesDone: 1 }), width: '25%' },
    { name: 'zero before anything is counted', status: syncing({ filesTotal: 0, filesDone: 0 }), width: '0%' },
    { name: 'at most 100%', status: syncing({ bytesTotal: 100, bytesDone: 150 }), width: '100%' },
  ])('fills the bar from $name', async ({ status, width }) => {
    const user = renderButton({ activity: 'downloading', tiers: [tier('daily', 'Daily', status)] });
    const popover = await openPopover(user);
    expect(barWidth(tierRow(popover, 'Daily'))).toBe(width);
  });

  it('reads an idle tier as synced when nothing is outstanding, and as idle otherwise', async () => {
    const lastSync = new Date(Date.now() - 2 * 3_600_000);
    const idle: SyncStatus = { status: 'idle', lastSync };
    const user = renderButton({ tiers: [tier('daily', 'Daily', idle)] });
    const popover = await openPopover(user);
    expect(within(tierRow(popover, 'Daily')).getByText('synced')).toBeDefined();
    expect(within(tierRow(popover, 'Daily')).getByText('· 2h ago')).toBeDefined();
    expect(within(popover).getByText('All periods synced')).toBeDefined();
  });

  it('reads an idle tier as idle while periods are missing', async () => {
    const user = renderButton({ missingPeriods: 2, tiers: [tier('daily', 'Daily', { status: 'idle', lastSync: null })] });
    const popover = await openPopover(user);
    expect(within(tierRow(popover, 'Daily')).getByText('idle')).toBeDefined();
  });

  it.each([
    { props: { missingPeriods: 1 }, footer: '1 period not synced' },
    { props: { missingPeriods: 4 }, footer: '4 periods not synced' },
    { props: { currentMonthUpdating: true }, footer: 'Current month updating' },
    { props: {}, footer: 'All periods synced' },
  ])('sums up with "$footer"', async ({ props, footer }) => {
    const user = renderButton(props);
    const popover = await openPopover(user);
    expect(within(popover).getByText(footer)).toBeDefined();
  });

  it('Manage data closes the popover and opens Data & Sync', async () => {
    const onManageData = vi.fn();
    const user = renderButton({ onManageData });
    const popover = await openPopover(user);

    await user.click(within(popover).getByRole('button', { name: 'Manage data' }));

    expect(onManageData).toHaveBeenCalledOnce();
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('re-checks for new data on demand, locking the button until the check settles', async () => {
    let finish: () => void = () => undefined;
    const onRecheck = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = renderButton({ onRecheck });
    const popover = await openPopover(user);
    const recheck = within(popover).getByRole('button', { name: 'Check for new data' });

    await user.click(recheck);
    expect(onRecheck).toHaveBeenCalledOnce();
    expect(recheck).toHaveProperty('disabled', true);

    await act(async () => { finish(); await Promise.resolve(); });
    await waitFor(() => { expect(recheck).toHaveProperty('disabled', false); });
  });

  describe('a sync error', () => {
    it('is shown with a bare Retry when it has no sign-in remedy', async () => {
      const onRecheck = vi.fn(() => Promise.resolve());
      const user = renderButton({ error: 'Access Denied on bucket acme-cur', onRecheck });
      const popover = await openPopover(user);

      const alert = within(popover).getByRole('alert');
      expect(alert.textContent).toContain('Access Denied on bucket acme-cur');
      expect(within(alert).queryByRole('button', { name: /SSO Login|Sign-in|sign in/i })).toBeNull();

      await user.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(onRecheck).toHaveBeenCalledOnce();
    });

    it('offers SSO login for the profile named in an expired-credentials error', async () => {
      const api = new MockCostApi();
      const ssoLogin = vi.spyOn(api, 'ssoLogin');
      const user = renderButton({ error: 'AWS credentials expired. Run: aws sso login --profile acme-billing' }, api);
      const popover = await openPopover(user);
      const alert = within(popover).getByRole('alert');

      await user.click(within(alert).getByRole('button', { name: 'Open SSO Login' }));

      expect(ssoLogin).toHaveBeenCalledWith('acme-billing');
      // The login panel brings its own retry; there is no second, bare one.
      expect(within(alert).getAllByRole('button', { name: /Retry/ })).toHaveLength(1);
    });

    it('falls back to a bare Retry when an SSO error names no profile', async () => {
      const user = renderButton({ error: 'Session expired. Run: aws sso login' });
      const popover = await openPopover(user);
      const alert = within(popover).getByRole('alert');
      expect(within(alert).queryByRole('button', { name: 'Open SSO Login' })).toBeNull();
      expect(within(alert).getByRole('button', { name: 'Retry' })).toBeDefined();
    });

    it.each([
      { store: 'Application Default Credentials', command: GCLOUD_ADC_LOGIN_COMMAND, button: 'Open Google Sign-in', mode: 'adc' },
      { store: 'gcloud CLI account', command: GCLOUD_CLI_LOGIN_COMMAND, button: 'Sign in the gcloud CLI', mode: 'cli' },
    ])('offers the gcloud sign-in for stale $store', async ({ command, button, mode }) => {
      const api = new MockCostApi();
      const gcloudLogin = vi.spyOn(api, 'gcloudLogin');
      const user = renderButton({ error: `GCP credentials are stale. Run: ${command}` }, api);
      const popover = await openPopover(user);
      const alert = within(popover).getByRole('alert');

      await user.click(within(alert).getByRole('button', { name: button }));

      expect(gcloudLogin).toHaveBeenCalledWith(mode);
      expect(within(alert).queryByRole('button', { name: 'Open SSO Login' })).toBeNull();
    });

    it('lets the panel Retry join a re-check already running from the header', async () => {
      let finish: () => void = () => undefined;
      const onRecheck = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const user = renderButton({ error: 'Access Denied', onRecheck });
      const popover = await openPopover(user);

      await user.click(within(popover).getByRole('button', { name: 'Check for new data' }));
      await user.click(within(popover).getByRole('button', { name: 'Retry' }));

      // One check, not two — and the Retry waits on it rather than returning
      // at once.
      expect(onRecheck).toHaveBeenCalledOnce();
      expect(within(popover).getByRole('button', { name: 'Retrying…' })).toBeDefined();

      await act(async () => { finish(); await Promise.resolve(); });
      expect(await within(popover).findByRole('button', { name: 'Retry' })).toBeDefined();
      expect(within(popover).getByRole('button', { name: 'Check for new data' })).toHaveProperty('disabled', false);
    });
  });
});
