import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  CostApi,
  DataInventoryResult,
  DataSharingResult,
  DataSharingStatus,
  SyncStatus,
  UpdateInfo,
  UpdateStatus,
  ViewsConfig,
  WorkspaceSummary,
  WorkspacesInfo,
} from '@costgoblin/core/browser';
import { MockCostApi } from '@costgoblin/ui';
import { App } from '../renderer/App.js';
import { fakeDebug, fakeUpdate } from './helpers/renderer-bridges.js';

type User = ReturnType<typeof userEvent.setup>;

// Dashboards without widgets: the shell is under test here, not the charts.
const VIEWS: ViewsConfig = {
  views: [
    { id: 'overview', name: 'Cost Overview', builtIn: true, rows: [] },
    { id: 'teams', name: 'Team costs', rows: [] },
  ],
};

const DEFAULT_WORKSPACE: WorkspaceSummary = { name: 'default', active: true, configured: true, sizeBytes: null, lastUsedAt: null };
const ACME_WORKSPACE: WorkspaceSummary = { name: 'client-acme', active: false, configured: true, sizeBytes: null, lastUsedAt: null };
const ONE_WORKSPACE: WorkspacesInfo = { mode: 'workspace', active: 'default', workspaces: [DEFAULT_WORKSPACE] };
const TWO_WORKSPACES: WorkspacesInfo = { mode: 'workspace', active: 'default', workspaces: [DEFAULT_WORKSPACE, ACME_WORKSPACE] };

const INFO: UpdateInfo = { version: '1.4.0', releaseDate: '2026-01-20', releaseNotes: '<p>Faster sync</p>' };

const IDLE: SyncStatus = { status: 'idle', lastSync: null };

class AppApi extends MockCostApi {
  views: ViewsConfig = VIEWS;
  workspaces: WorkspacesInfo = ONE_WORKSPACE;
  override getViewsConfig(): Promise<ViewsConfig> { return Promise.resolve(this.views); }
  override getWorkspaces(): Promise<WorkspacesInfo> { return Promise.resolve(this.workspaces); }
}

function deferred<T = undefined>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** `YYYY-MM` of the month `monthsAgo` before the current one. */
function periodAgo(monthsAgo: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function inventoryOf(periods: DataInventoryResult['periods']): DataInventoryResult {
  return {
    periods,
    totalRemoteSize: 0,
    totalLocalPeriods: 0,
    totalRemotePeriods: periods.length,
    lastSync: null,
    local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null },
  };
}

function renderApp(api: MockCostApi): User {
  globalThis.costgoblin = api;
  const user = userEvent.setup();
  render(<App />);
  return user;
}

/** Boot to the default dashboard. */
async function bootApp(api: MockCostApi = new AppApi()): Promise<User> {
  const user = renderApp(api);
  await screen.findByRole('heading', { name: 'Cost Overview' });
  return user;
}

function headerButton(name: string): HTMLButtonElement {
  const el = screen.getByRole('button', { name });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
  return el;
}

async function openSettingsTab(user: User, label: string): Promise<void> {
  if (screen.queryByRole('navigation', { name: 'Settings sections' }) === null) {
    await user.click(headerButton('Settings'));
  }
  const rail = await screen.findByRole('navigation', { name: 'Settings sections' });
  await user.click(within(rail).getByRole('button', { name: label }));
}

async function runCommand(user: User, label: string): Promise<void> {
  await user.keyboard('{Meta>}k{/Meta}');
  await screen.findByPlaceholderText('Type to search...');
  await user.click(screen.getByRole('option', { name: label }));
}

/** The polite live region the shell announces sync progress in. */
function syncAnnouncement(): string {
  const region = document.querySelector('[aria-live="polite"][aria-atomic="true"]');
  return region?.textContent ?? '';
}

function syncErrorAnnouncement(): string {
  const region = document.querySelector('[aria-live="assertive"][aria-atomic="true"]');
  return region?.textContent ?? '';
}

describe('App shell — header actions', () => {
  it('reloads data after confirming: clears caches and the query log, and locks the button meanwhile', async () => {
    const api = new AppApi();
    const clearing = deferred();
    const clearAllCaches = vi.spyOn(api, 'clearAllCaches').mockReturnValue(clearing.promise);
    const clearLog = vi.spyOn(fakeDebug, 'clearLog');
    const user = await bootApp(api);

    await user.click(headerButton('Reload data'));
    const dialog = await screen.findByRole('dialog', { name: 'Reload data?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reload' }));

    expect(clearAllCaches).toHaveBeenCalledOnce();
    await waitFor(() => { expect(headerButton('Reload data').disabled).toBe(true); });

    // A second reload while the first runs is ignored.
    await runCommand(user, 'Reload data');
    await user.click(within(await screen.findByRole('dialog', { name: 'Reload data?' })).getByRole('button', { name: 'Reload' }));
    expect(clearAllCaches).toHaveBeenCalledOnce();

    await act(async () => { clearing.resolve(undefined); await clearing.promise; });
    await waitFor(() => { expect(headerButton('Reload data').disabled).toBe(false); });
    expect(clearLog).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'Cost Overview' })).toBeDefined();
  });

  it('cancelling the reload clears nothing', async () => {
    const api = new AppApi();
    const clearAllCaches = vi.spyOn(api, 'clearAllCaches');
    const user = await bootApp(api);

    await user.click(headerButton('Reload data'));
    const dialog = await screen.findByRole('dialog', { name: 'Reload data?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Reload data?' })).toBeNull(); });
    expect(clearAllCaches).not.toHaveBeenCalled();
  });

  it('toggles the debug panel from the header, and closes it from its own button', async () => {
    const user = await bootApp();

    await user.click(headerButton('Debug panel'));
    expect(headerButton('Debug panel').getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'Query Log' })).toBeDefined();

    await user.click(headerButton('Debug panel'));
    expect(screen.queryByRole('heading', { name: 'Query Log' })).toBeNull();

    await user.click(headerButton('Debug panel'));
    await screen.findByRole('heading', { name: 'Query Log' });
    // The panel's icon-only close button is the one without a name.
    await user.click(screen.getByRole('button', { name: '' }));
    expect(screen.queryByRole('heading', { name: 'Query Log' })).toBeNull();
    expect(headerButton('Debug panel').getAttribute('aria-pressed')).toBe('false');
  });

  it('badges the debug button with the IPC calls in flight', async () => {
    fakeDebug.inFlightCount = 4;
    await bootApp();
    await waitFor(() => { expect(headerButton('Debug panel').textContent).toBe('4'); });
  });

  it('goes home to the default dashboard, naming it in the tooltip', async () => {
    const user = await bootApp();
    expect(headerButton('Home').getAttribute('title')).toBe('Go to Cost Overview');
    expect(headerButton('Home').getAttribute('aria-current')).toBe('page');

    await runCommand(user, 'Team costs');
    expect(await screen.findByRole('heading', { name: 'Team costs' })).toBeDefined();
    expect(headerButton('Home').getAttribute('aria-current')).toBeNull();

    await user.click(headerButton('Home'));
    expect(await screen.findByRole('heading', { name: 'Cost Overview' })).toBeDefined();
  });

  it('marks the analysis page that is open', async () => {
    const user = await bootApp();
    await user.click(headerButton('Explorer'));
    // The active entry shows its label instead of a tooltip.
    const explorer = await screen.findByRole('button', { name: 'Explorer' });
    await waitFor(() => { expect(explorer.getAttribute('aria-current')).toBe('page'); });
    expect(explorer.getAttribute('title')).toBeNull();
    expect(headerButton('Trends').getAttribute('aria-current')).toBeNull();
  });

  it('falls back to the first dashboard when the saved default no longer exists', async () => {
    const api = new AppApi();
    const asCostApi: CostApi = api;
    vi.spyOn(asCostApi, 'getUIPreferences').mockResolvedValue({ theme: 'dark', palette: 'standard', defaultViewId: 'deleted-view' });
    renderApp(api);

    expect(await screen.findByRole('heading', { name: 'Cost Overview' })).toBeDefined();
    expect(headerButton('Home').getAttribute('title')).toBe('Go to default dashboard');
  });

  it('falls back to the seed dashboard when none are configured', async () => {
    const api = new AppApi();
    api.views = { views: [] };
    const user = await bootApp(api);
    await user.click(headerButton('Dashboards'));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Cost Overview']);
  });

  it('still boots when the dashboards, preferences or update status cannot be read', async () => {
    const api = new AppApi();
    vi.spyOn(api, 'getViewsConfig').mockRejectedValue(new Error('views.yaml is corrupt'));
    vi.spyOn(api, 'getUIPreferences').mockRejectedValue(new Error('ipc down'));
    vi.spyOn(fakeUpdate, 'getStatus').mockRejectedValue(new Error('ipc down'));
    const user = await bootApp(api);

    await user.click(headerButton('Dashboards'));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Cost Overview']);
  });
});

describe('App shell — reload and startup', () => {
  it('finishes a reload even when clearing the caches fails', async () => {
    const api = new AppApi();
    vi.spyOn(api, 'clearAllCaches').mockRejectedValue(new Error('cache dir locked'));
    const clearLog = vi.spyOn(fakeDebug, 'clearLog');
    const user = await bootApp(api);

    await user.click(headerButton('Reload data'));
    await user.click(within(await screen.findByRole('dialog', { name: 'Reload data?' })).getByRole('button', { name: 'Reload' }));

    await waitFor(() => { expect(clearLog).toHaveBeenCalledOnce(); });
    await waitFor(() => { expect(headerButton('Reload data').disabled).toBe(false); });
  });

  it('rotates the splash artwork while it connects', () => {
    vi.useFakeTimers();
    const api = new AppApi();
    vi.spyOn(api, 'getSetupStatus').mockReturnValue(new Promise(() => undefined));
    renderApp(api);
    const shown = (): string | undefined => [...document.querySelectorAll('img')].find(img => img.style.opacity === '1')?.getAttribute('src') ?? undefined;
    expect(screen.getByText('Checking configuration...')).toBeDefined();
    const first = shown();
    expect(first).toMatch(/^splash-\d+\.png$/);

    act(() => { vi.advanceTimersByTime(500); });

    expect(shown()).toMatch(/^splash-\d+\.png$/);
    expect(shown()).not.toBe(first);
  });

  it('lands on Data & Sync on the first launch after setup', async () => {
    const api = new AppApi();
    vi.spyOn(api, 'getSetupStatus').mockResolvedValue({ configured: true, postSetup: true });
    renderApp(api);
    expect(await screen.findByRole('heading', { name: 'Data Management' })).toBeDefined();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeDefined();
  });

  it('warms every dimension\'s filter values in the background once the app is up', async () => {
    const api = new AppApi();
    const asCostApi: CostApi = api;
    const probe = vi.spyOn(asCostApi, 'getFilterValues');
    const dimensions = await api.getDimensions();
    await bootApp(api);

    await waitFor(() => {
      const warmups = probe.mock.calls.filter(call => call[4]?.startsWith('splash:warmup:') === true);
      expect(warmups).toHaveLength(dimensions.length);
    });
    const warmups = probe.mock.calls.filter(c => c[4]?.startsWith('splash:warmup:') === true);
    // One unfiltered probe per dimension, each tagged with the dimension it warms…
    expect(new Set(warmups.map(c => c[0])).size).toBe(dimensions.length);
    for (const [dimension, filters, range, , origin] of warmups) {
      expect(origin).toBe(`splash:warmup:${dimension}`);
      expect(filters).toEqual({});
      // …over the default 30-day window.
      if (range === undefined) throw new Error('warm-up probe without a date range');
      expect(Date.parse(range.end) - Date.parse(range.start)).toBe(30 * 86_400_000);
    }
  });

  it('skips the warm-up when there are no dimensions', async () => {
    const api = new AppApi();
    const asCostApi: CostApi = api;
    const listDimensions = vi.spyOn(api, 'getDimensions').mockResolvedValue([]);
    const probe = vi.spyOn(asCostApi, 'getFilterValues');
    await bootApp(api);
    await waitFor(() => { expect(listDimensions).toHaveBeenCalled(); });
    await act(async () => { await listDimensions.mock.results[0]?.value; });
    expect(probe.mock.calls.filter(call => call[4]?.startsWith('splash:warmup:') === true)).toEqual([]);
  });
});

describe('App shell — settings', () => {
  it.each([
    { tab: 'Performance', heading: 'Performance' },
    { tab: 'Telemetry', heading: 'Telemetry' },
    { tab: 'Share', heading: 'Share configuration' },
    { tab: 'Import', heading: 'Import configuration' },
    { tab: 'AI Assistant', heading: 'AI Assistant' },
    { tab: 'Dimensions', heading: 'Dimensions' },
    { tab: 'Dashboards', heading: 'Views' },
    { tab: 'Cost Scope', heading: 'Exclusion rules' },
  ])('opens the $tab tab', async ({ tab, heading }) => {
    const user = await bootApp();
    await openSettingsTab(user, tab);
    expect(await screen.findByRole('heading', { name: heading })).toBeDefined();
  });

  it('reloads the whole renderer once a teammate\'s configuration is imported', async () => {
    const reload = vi.fn();
    // jsdom cannot navigate; the import path only ever calls reload().
    vi.stubGlobal('location', { reload });
    const user = await bootApp();
    await openSettingsTab(user, 'Import');

    await user.click(await screen.findByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Apply configuration' }));
    await screen.findByText('Configuration applied.');
    expect(reload).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it('returns to the dashboards with Done', async () => {
    const user = await bootApp();
    await openSettingsTab(user, 'Performance');
    await screen.findByRole('heading', { name: 'Performance' });

    await user.click(headerButton('Done, return to dashboards'));

    expect(await screen.findByRole('heading', { name: 'Cost Overview' })).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
  });

  it('saves the palette and default-dashboard choices made in General', async () => {
    const api = new AppApi();
    const save = vi.spyOn(api, 'saveUIPreferences');
    const user = await bootApp(api);
    await openSettingsTab(user, 'General');

    await user.click(await screen.findByRole('button', { name: 'Colorblind' }));
    expect(save).toHaveBeenLastCalledWith({ theme: 'dark', palette: 'colorblind', defaultViewId: 'overview' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Default dashboard' }), 'Team costs');
    expect(save).toHaveBeenLastCalledWith({ theme: 'dark', palette: 'colorblind', defaultViewId: 'teams' });

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', palette: 'colorblind', defaultViewId: 'teams' });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('saves against the light theme and back to the standard palette too', async () => {
    const api = new AppApi();
    const asCostApi: CostApi = api;
    vi.spyOn(asCostApi, 'getUIPreferences').mockResolvedValue({ theme: 'light', palette: 'colorblind', defaultViewId: 'overview' });
    const save = vi.spyOn(api, 'saveUIPreferences');
    const user = await bootApp(api);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    await openSettingsTab(user, 'General');

    await user.click(await screen.findByRole('button', { name: 'Standard' }));
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', palette: 'standard', defaultViewId: 'overview' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Default dashboard' }), 'Team costs');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', palette: 'standard', defaultViewId: 'teams' });
  });

  it('keeps a new default dashboard for the session when saving it fails', async () => {
    const api = new AppApi();
    vi.spyOn(api, 'saveUIPreferences').mockRejectedValue(new Error('EROFS: read-only file system'));
    const user = await bootApp(api);
    await openSettingsTab(user, 'General');

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Default dashboard' }), 'Team costs');
    await user.click(headerButton('Done, return to dashboards'));

    await waitFor(() => { expect(headerButton('Home').getAttribute('title')).toBe('Go to Team costs'); });
  });

  it('checks for updates from General', async () => {
    const check = vi.spyOn(fakeUpdate, 'checkForUpdates');
    const user = await bootApp();
    await openSettingsTab(user, 'General');

    await user.click(await screen.findByRole('button', { name: 'Check for updates' }));

    expect(check).toHaveBeenCalledOnce();
  });

  it('reverts the update-check preference when saving it fails', async () => {
    vi.spyOn(fakeUpdate, 'setCheckOnStartup').mockRejectedValue(new Error('read-only workspace'));
    const reread = vi.spyOn(fakeUpdate, 'getCheckOnStartup');
    const user = await bootApp();
    await openSettingsTab(user, 'General');
    await screen.findByRole('button', { name: 'Manual only' });
    const readsBefore = reread.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Manual only' }));

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe('true'); });
    expect(reread.mock.calls.length).toBe(readsBefore + 1);
  });

  it('opens the release notes from the General tab', async () => {
    fakeUpdate.snapshot = { status: { state: 'available', info: INFO }, checkedThisSession: true };
    const user = renderApp(new AppApi());
    // The available update prompts once on its own; dismiss that first.
    const prompt = await screen.findByRole('dialog', { name: /Update Available/ });
    await user.click(within(prompt).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });

    // The gear carries the update dot and lands on General.
    expect(headerButton('Settings').getAttribute('title')).toBe('Update available');
    await user.click(headerButton('Settings'));
    await user.click(await screen.findByRole('button', { name: 'v1.4.0 available' }));

    expect(await screen.findByRole('dialog', { name: /Update Available — v1.4.0/ })).toBeDefined();
  });

  it('re-runs the setup wizard from General, without the first-run naming step', async () => {
    const user = await bootApp();
    await openSettingsTab(user, 'General');

    await user.click(await screen.findByRole('button', { name: 'Run setup again' }));

    expect(await screen.findByLabelText('Set up from Google Cloud')).toBeDefined();
    expect(screen.queryByLabelText('Workspace name')).toBeNull();
  });
});

describe('App shell — command palette', () => {
  it('opens settings tabs and the workspaces page', async () => {
    const user = await bootApp();

    await runCommand(user, 'Performance');
    expect(await screen.findByRole('heading', { name: 'Performance' })).toBeDefined();

    await runCommand(user, 'New workspace…');
    expect(await screen.findByRole('heading', { name: 'Workspaces' })).toBeDefined();
  });

  it('asks before switching workspace, and restarts into it on confirm', async () => {
    const api = new AppApi();
    api.workspaces = TWO_WORKSPACES;
    const switchWorkspace = vi.spyOn(api, 'switchWorkspace');
    const user = await bootApp(api);

    await runCommand(user, 'Switch to workspace: client-acme');

    expect(await screen.findByText('Switch to workspace "client-acme"? CostGoblin will restart.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Switch & Restart' }));
    expect(switchWorkspace).toHaveBeenCalledWith('client-acme');
    await waitFor(() => { expect(screen.queryByText(/CostGoblin will restart/)).toBeNull(); });
  });

  it('warns that switching workspace interrupts a running sync', async () => {
    const api = new AppApi();
    api.workspaces = TWO_WORKSPACES;
    api.getSyncStatus = (syncId) => Promise.resolve(syncId === 'daily'
      ? { status: 'syncing', phase: 'downloading', progress: 0.3, filesTotal: 10, filesDone: 3, bytesTotal: 0, bytesDone: 0, message: '' }
      : IDLE);
    const user = await bootApp(api);
    await waitFor(() => { expect(headerButton('Data sync').getAttribute('title')).toBe('Syncing…'); });

    await user.click(screen.getByTestId('workspace-chip'));
    await user.click(screen.getByRole('button', { name: 'client-acme' }));

    expect(await screen.findByText(/A sync is currently running and will be interrupted\./)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByText(/A sync is currently running/)).toBeNull(); });
  });

  it('manages workspaces from the workspace chip', async () => {
    const api = new AppApi();
    api.workspaces = TWO_WORKSPACES;
    const user = await bootApp(api);

    await user.click(screen.getByTestId('workspace-chip'));
    await user.click(screen.getByRole('button', { name: 'Manage workspaces…' }));

    expect(await screen.findByRole('heading', { name: 'Workspaces' })).toBeDefined();
  });
});

describe('App shell — updates', () => {
  it('prompts for an available update and follows it through download to install', async () => {
    const download = vi.spyOn(fakeUpdate, 'downloadUpdate');
    const install = vi.spyOn(fakeUpdate, 'quitAndInstall');
    const user = await bootApp();

    act(() => { fakeUpdate.statusPushes.emit({ state: 'available', info: INFO }); });
    const available = await screen.findByRole('dialog', { name: /Update Available — v1\.4\.0/ });
    expect(within(available).getByText('Released 2026-01-20')).toBeDefined();
    expect(within(available).getByText('Faster sync')).toBeDefined();
    await user.click(within(available).getByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledOnce();

    act(() => { fakeUpdate.statusPushes.emit({ state: 'downloading', percent: 0, info: INFO }); });
    expect(await screen.findByRole('dialog', { name: /Downloading Update — v1\.4\.0/ })).toBeDefined();
    expect(screen.getByText('Preparing...')).toBeDefined();
    expect(screen.queryByText('0%')).toBeNull();

    act(() => { fakeUpdate.statusPushes.emit({ state: 'downloading', percent: 42, info: INFO }); });
    expect(await screen.findByText('Downloading...')).toBeDefined();
    expect(screen.getByText('42%')).toBeDefined();

    act(() => { fakeUpdate.statusPushes.emit({ state: 'downloaded', info: { ...INFO, releaseNotes: null } }); });
    const ready = await screen.findByRole('dialog', { name: /Ready to Install — v1\.4\.0/ });
    expect(within(ready).queryByText('Faster sync')).toBeNull();
    await user.click(within(ready).getByRole('button', { name: 'Install and Restart' }));
    expect(install).toHaveBeenCalledOnce();
  });

  it.each([
    { stage: 'check' as const, label: 'Checking for updates' },
    { stage: 'download' as const, label: 'Downloading update' },
    { stage: 'install' as const, label: 'Installing update' },
  ])('explains a failed $stage, with its recent events, and retries', async ({ stage, label }) => {
    const retry = vi.spyOn(fakeUpdate, 'checkForUpdates');
    const user = await bootApp();
    const at = (s: number): number => new Date(2026, 0, 15, 9, 5, s).getTime();
    const error: UpdateStatus = {
      state: 'error',
      error: 'net::ERR_INTERNET_DISCONNECTED',
      stage,
      logs: [
        { timestamp: at(7), level: 'info', message: 'Starting' },
        { timestamp: at(8), level: 'warn', message: 'Slow response' },
        { timestamp: at(9), level: 'error', message: 'Timed out' },
      ],
    };

    act(() => { fakeUpdate.statusPushes.emit(error); });

    const dialog = await screen.findByRole('dialog', { name: 'Update failed' });
    expect(within(dialog).getByText(`${label} did not complete. You can try again or copy the log below.`)).toBeDefined();
    expect(within(dialog).getByText('net::ERR_INTERNET_DISCONNECTED')).toBeDefined();
    expect(within(dialog).getByText('[09:05:07] INFO: Starting')).toBeDefined();
    expect(within(dialog).getByText('[09:05:08] WARN: Slow response')).toBeDefined();
    expect(within(dialog).getByText('[09:05:09] ERROR: Timed out')).toBeDefined();

    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('leaves out the event list when a failure logged nothing', async () => {
    await bootApp();
    act(() => { fakeUpdate.statusPushes.emit({ state: 'error', error: 'ENOSPC', stage: 'download', logs: [] }); });
    const dialog = await screen.findByRole('dialog', { name: 'Update failed' });
    expect(within(dialog).queryByText('Recent events')).toBeNull();
  });
});

describe('App shell — sync status', () => {
  function syncingDaily(filesTotal: number, filesDone: number): (syncId?: string) => Promise<SyncStatus> {
    return (syncId) => Promise.resolve(syncId === 'daily'
      ? { status: 'syncing', phase: 'downloading', progress: 0, filesTotal, filesDone, bytesTotal: 0, bytesDone: 0, message: '' }
      : IDLE);
  }

  it.each([
    { filesTotal: 10, filesDone: 3, announced: 'Downloading 7 files' },
    { filesTotal: 4, filesDone: 3, announced: 'Downloading 1 file' },
  ])('announces "$announced" and badges the sync button', async ({ filesTotal, filesDone, announced }) => {
    const api = new AppApi();
    api.getSyncStatus = syncingDaily(filesTotal, filesDone);
    await bootApp(api);

    await waitFor(() => { expect(syncAnnouncement()).toBe(announced); });
    expect(headerButton('Data sync').textContent).toBe(String(filesTotal - filesDone));
  });

  it('announces a check for new data', async () => {
    const api = new AppApi();
    const asCostApi: CostApi = api;
    vi.spyOn(asCostApi, 'getAutoSyncStatus').mockResolvedValue({ state: 'checking' });
    await bootApp(api);
    await waitFor(() => { expect(syncAnnouncement()).toBe('Checking for updates'); });
  });

  /** Park the missing-periods check. Its success clears whatever sync error
   *  is showing — the poller's included — so letting it settle would race the
   *  poller's error off the button (a bug of its own; not asserted here). */
  function holdInventoryCheck(api: AppApi): void {
    vi.spyOn(api, 'getDataInventory').mockReturnValue(new Promise<DataInventoryResult>(() => undefined));
  }

  it('surfaces an auto-sync failure on the sync button and to screen readers', async () => {
    const api = new AppApi();
    const asCostApi: CostApi = api;
    vi.spyOn(asCostApi, 'getAutoSyncStatus').mockResolvedValue({ state: 'error', message: 'Rate exceeded', lastRun: null });
    holdInventoryCheck(api);
    await bootApp(api);

    await waitFor(() => { expect(headerButton('Data sync').getAttribute('title')).toBe('Sync error — Rate exceeded'); });
    expect(syncErrorAnnouncement()).toBe('Sync error: Rate exceeded');
  });

  it('surfaces a failed tier download', async () => {
    const api = new AppApi();
    api.getSyncStatus = (syncId) => Promise.resolve(syncId === 'hourly'
      ? { status: 'failed', error: new Error('AccessDenied: hourly bucket'), lastSync: null }
      : IDLE);
    holdInventoryCheck(api);
    await bootApp(api);
    await waitFor(() => { expect(headerButton('Data sync').getAttribute('title')).toBe('Sync error — AccessDenied: hourly bucket'); });
  });

  it('counts closed months with no or outdated local data as not synced', async () => {
    const api = new AppApi();
    vi.spyOn(api, 'getDataInventory').mockResolvedValue(inventoryOf([
      { period: periodAgo(3), files: [], totalSize: 0, localStatus: 'repartitioned' },
      { period: periodAgo(2), files: [], totalSize: 0, localStatus: 'missing' },
      { period: periodAgo(1), files: [], totalSize: 0, localStatus: 'stale' },
      // The open month is always being re-published: "updating", not missing.
      { period: periodAgo(0), files: [], totalSize: 0, localStatus: 'stale' },
    ]));
    const user = await bootApp(api);

    await waitFor(() => { expect(syncAnnouncement()).toBe('2 billing periods not synced'); });
    expect(headerButton('Data sync').getAttribute('title')).toBe('2 billing periods not synced');
    await user.click(headerButton('Data sync'));
    expect(await screen.findByText('2 periods not synced')).toBeDefined();
  });

  const GAPS = inventoryOf([
    { period: periodAgo(6), files: [], totalSize: 0, localStatus: 'missing' },
    { period: periodAgo(1), files: [], totalSize: 0, localStatus: 'missing' },
  ]);

  it('only counts months inside the daily retention window', async () => {
    // The fixture provider keeps 90 days: the six-month-old gap is out of scope.
    const api = new AppApi();
    vi.spyOn(api, 'getDataInventory').mockResolvedValue(GAPS);
    await bootApp(api);

    await waitFor(() => { expect(syncAnnouncement()).toBe('1 billing period not synced'); });
    expect(headerButton('Data sync').getAttribute('title')).toBe('1 billing period not synced');
  });

  it('falls back to a year of retention when no provider is configured', async () => {
    const api = new AppApi();
    const config = await api.getConfig();
    vi.spyOn(api, 'getConfig').mockResolvedValue({ ...config, providers: [] });
    vi.spyOn(api, 'getDataInventory').mockResolvedValue(GAPS);
    await bootApp(api);

    await waitFor(() => { expect(syncAnnouncement()).toBe('2 billing periods not synced'); });
  });

  it.each([
    { name: 'an Error', thrown: new Error('The security token included in the request is expired'), shown: 'The security token included in the request is expired' },
    { name: 'a plain value', thrown: 'inventory unavailable', shown: 'inventory unavailable' },
  ])('reports $name thrown while checking for missing periods', async ({ thrown, shown }) => {
    const api = new AppApi();
    vi.spyOn(api, 'getDataInventory').mockRejectedValue(thrown);
    await bootApp(api);
    await waitFor(() => { expect(headerButton('Data sync').getAttribute('title')).toBe(`Sync error — ${shown}`); });
  });

  it('opens Data & Sync from the sync popover', async () => {
    const user = await bootApp();
    await user.click(headerButton('Data sync'));
    await user.click(await screen.findByRole('button', { name: 'Manage data' }));
    expect(await screen.findByRole('heading', { name: 'Data Management' })).toBeDefined();
  });
});

describe('App shell — data sharing banner', () => {
  const SHARING: DataSharingStatus = {
    enabled: true,
    sharingKey: 'CGSHARE1-test-key',
    label: 'Test · CostGoblin',
    port: 53178,
    hosts: ['peer.local'],
    fingerprint: 'ABCD-EF01-2345-6789',
    lastServedAt: null,
    filesServed: 0,
    lastPeer: null,
    bytesServed: 0,
    connectedClients: 0,
    bytesPerSecond: 0,
    autoStopsAt: null,
  };
  const STOPPED: DataSharingStatus = { ...SHARING, enabled: false, sharingKey: null, port: null, hosts: [] };

  class SharingApi extends AppApi {
    sharing: DataSharingStatus = SHARING;
    stopResult: DataSharingResult = { status: 'ok', sharing: STOPPED };
    override getDataSharingStatus(): Promise<DataSharingStatus> { return Promise.resolve(this.sharing); }
    override disableDataSharing(): Promise<DataSharingResult> {
      if (this.stopResult.status === 'ok') this.sharing = this.stopResult.sharing;
      return Promise.resolve(this.stopResult);
    }
  }

  it('shows while sharing is on, and Stop sharing turns it off', async () => {
    const api = new SharingApi();
    const user = await bootApp(api);

    await user.click(await screen.findByRole('button', { name: 'Stop sharing' }));

    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Stop sharing' })).toBeNull(); });
    expect(api.sharing.enabled).toBe(false);
  });

  it('re-enables Stop sharing when the request itself fails', async () => {
    const api = new SharingApi();
    vi.spyOn(api, 'disableDataSharing').mockRejectedValue(new Error('ipc down'));
    const user = await bootApp(api);

    await user.click(await screen.findByRole('button', { name: 'Stop sharing' }));

    expect(await screen.findByRole('button', { name: 'Stop sharing' })).toHaveProperty('disabled', false);
  });

  it('keeps the banner when stopping fails', async () => {
    const api = new SharingApi();
    api.stopResult = { status: 'error', message: 'port busy' };
    const disable = vi.spyOn(api, 'disableDataSharing');
    const user = await bootApp(api);

    await user.click(await screen.findByRole('button', { name: 'Stop sharing' }));

    await waitFor(() => { expect(disable).toHaveBeenCalledOnce(); });
    expect(await screen.findByRole('button', { name: 'Stop sharing' })).toBeDefined();
  });
});

describe('App shell — first run', () => {
  class FirstRunApi extends AppApi {
    override getSetupStatus(): Promise<{ configured: boolean; postSetup: boolean }> {
      return Promise.resolve({ configured: false, postSetup: false });
    }
  }

  /** Finish the wizard the shortest way — the hand-written GCP config — and
   *  then the telemetry step that follows it. */
  async function completeSetup(user: User): Promise<void> {
    await user.click(await screen.findByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Write the config by hand instead'));
    await user.click(await screen.findByText("I've saved it — restart"));
    expect(await screen.findByRole('heading', { name: 'Help improve CostGoblin?' })).toBeDefined();
    const finish = screen.getByRole('button', { name: 'Finish' });
    await waitFor(() => { expect(finish).toHaveProperty('disabled', false); });
    await user.click(finish);
  }

  it('holds the splash until the workspaces are known, then opens on the naming step', async () => {
    const api = new FirstRunApi();
    const workspaces = deferred<WorkspacesInfo>();
    vi.spyOn(api, 'getWorkspaces').mockReturnValue(workspaces.promise);
    renderApp(api);

    expect(await screen.findByText('Checking configuration...')).toBeDefined();
    await act(async () => { workspaces.resolve(api.workspaces); await workspaces.promise; });

    expect(await screen.findByLabelText('Workspace name')).toHaveProperty('value', 'default');
  });

  it('claims the chosen workspace name when setup completes', async () => {
    const api = new FirstRunApi();
    const claim = vi.spyOn(api, 'completeSetup');
    const relaunch = vi.spyOn(fakeUpdate, 'relaunch');
    const user = renderApp(api);
    const name = await screen.findByLabelText('Workspace name');
    await user.clear(name);
    await user.type(name, 'acme');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await completeSetup(user);

    await waitFor(() => { expect(claim).toHaveBeenCalledWith('acme'); });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('relaunches anyway when the name cannot be claimed', async () => {
    const api = new FirstRunApi();
    api.completeSetup = () => Promise.reject(new Error('EEXIST'));
    const relaunch = vi.spyOn(fakeUpdate, 'relaunch');
    const user = renderApp(api);
    const name = await screen.findByLabelText('Workspace name');
    await user.clear(name);
    await user.type(name, 'acme');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await completeSetup(user);

    await waitFor(() => { expect(relaunch).toHaveBeenCalledWith(true); });
  });

  it('relaunches onto Data & Sync when the default name is kept', async () => {
    const api = new FirstRunApi();
    const claim = vi.spyOn(api, 'completeSetup');
    const relaunch = vi.spyOn(fakeUpdate, 'relaunch');
    const user = renderApp(api);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    await completeSetup(user);

    await waitFor(() => { expect(relaunch).toHaveBeenCalledWith(true); });
    expect(claim).not.toHaveBeenCalled();
  });

  it('offers the other configured workspaces to jump back into', async () => {
    const api = new FirstRunApi();
    api.workspaces = TWO_WORKSPACES;
    const user = renderApp(api);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Jump back into an existing workspace:')).toBeDefined();
    expect(screen.getByRole('button', { name: 'client-acme' })).toBeDefined();
  });

  it('skips the naming step when the workspaces cannot be listed', async () => {
    const api = new FirstRunApi();
    vi.spyOn(api, 'getWorkspaces').mockRejectedValue(new Error('ipc down'));
    renderApp(api);
    expect(await screen.findByLabelText('Set up from Google Cloud')).toBeDefined();
    expect(screen.queryByLabelText('Workspace name')).toBeNull();
  });
});
