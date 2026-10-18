import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryOutboxEntry, TelemetryPreferences, TelemetryStatus } from '@costgoblin/core/browser';
import { CostApiProvider, MockCostApi } from '@costgoblin/ui';
import { TelemetryTab } from '../renderer/settings/telemetry-tab.js';
import { fakeUpdate } from './helpers/renderer-bridges.js';

const ALL_OFF: TelemetryPreferences = { errorReports: false, nativeCrashReports: false, performance: false, analytics: false };

function telemetryStatus(fields: Partial<TelemetryStatus> = {}): TelemetryStatus {
  return { dsnConfigured: true, active: false, preferences: ALL_OFF, armed: ALL_OFF, tracesSampleRate: 0.1, ...fields };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The main process's telemetry handlers: saved preferences, the reporter's
 *  status and the audit log, each a field a test sets. */
class TelemetryApi extends MockCostApi {
  prefs: TelemetryPreferences = ALL_OFF;
  status: TelemetryStatus = telemetryStatus();
  outbox: readonly TelemetryOutboxEntry[] = [];
  readonly saves: TelemetryPreferences[] = [];
  /** How each save settles — resolved unless a test says otherwise. */
  saveOutcome: () => Promise<void> = () => Promise.resolve();

  override getTelemetryPreferences(): Promise<TelemetryPreferences> { return Promise.resolve(this.prefs); }
  override setTelemetryPreferences(prefs?: TelemetryPreferences): Promise<void> {
    if (prefs !== undefined) this.saves.push(prefs);
    return this.saveOutcome();
  }
  override getTelemetryStatus(): Promise<TelemetryStatus> { return Promise.resolve(this.status); }
  override getTelemetryOutbox(): Promise<readonly TelemetryOutboxEntry[]> { return Promise.resolve(this.outbox); }
}

async function renderTab(api: TelemetryApi): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <TelemetryTab />
    </CostApiProvider>,
  );
  await screen.findByRole('heading', { name: 'Telemetry' });
  return user;
}

function toggle(label: string): HTMLElement {
  return screen.getByRole('switch', { name: `Toggle ${label}` });
}

function isOn(label: string): boolean {
  return toggle(label).getAttribute('aria-checked') === 'true';
}

function isDisabled(el: HTMLElement): boolean {
  return el instanceof HTMLButtonElement && el.disabled;
}

/** The settings row that holds a channel's switch. */
function channelRow(label: string): HTMLElement {
  const row = toggle(label).parentElement;
  if (row === null) throw new Error(`no row for ${label}`);
  return row;
}

const RESTART_PROMPT = 'Restart CostGoblin to apply your telemetry change.';
const CHANNELS = ['Error reports', 'Native crash reports', 'Performance metrics', 'Usage analytics'];

describe('TelemetryTab', () => {
  it('shows a loading state until preferences, status and audit log have all loaded', async () => {
    const api = new TelemetryApi();
    const status = deferred();
    vi.spyOn(api, 'getTelemetryStatus').mockImplementation(async () => {
      await status.promise;
      return telemetryStatus();
    });
    render(<CostApiProvider value={api}><TelemetryTab /></CostApiProvider>);
    expect(screen.getByText('Loading…')).toBeDefined();

    await act(async () => { status.resolve(); await status.promise; });
    expect(await screen.findByRole('heading', { name: 'Telemetry' })).toBeDefined();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('stays on the loading state when the settings cannot be read', async () => {
    const api = new TelemetryApi();
    const read = vi.spyOn(api, 'getTelemetryStatus').mockRejectedValue(new Error('ipc down'));
    render(<CostApiProvider value={api}><TelemetryTab /></CostApiProvider>);
    await waitFor(() => { expect(read).toHaveBeenCalledOnce(); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Loading…')).toBeDefined();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('lists every channel off by default, with analytics reserved as "Coming soon"', async () => {
    await renderTab(new TelemetryApi());
    for (const label of CHANNELS) expect(isOn(label)).toBe(false);
    expect(within(channelRow('Usage analytics')).getByText('Coming soon')).toBeDefined();
    expect(isDisabled(toggle('Usage analytics'))).toBe(true);
    for (const label of CHANNELS.slice(0, 3)) {
      expect(isDisabled(toggle(label))).toBe(false);
      expect(within(channelRow(label)).queryByText('Coming soon')).toBeNull();
    }
  });

  it('reflects the saved preferences and badges only the channels capturing right now', async () => {
    const api = new TelemetryApi();
    api.prefs = { errorReports: true, nativeCrashReports: false, performance: true, analytics: false };
    // Performance was enabled mid-session, so it is saved but not yet armed;
    // a stray armed flag on the reserved analytics channel earns no badge.
    api.status = telemetryStatus({
      active: true,
      armed: { errorReports: true, nativeCrashReports: false, performance: false, analytics: true },
    });
    await renderTab(api);

    expect(isOn('Error reports')).toBe(true);
    expect(isOn('Performance metrics')).toBe(true);
    expect(isOn('Native crash reports')).toBe(false);
    expect(within(channelRow('Error reports')).getByText('● Active')).toBeDefined();
    expect(screen.getAllByText('● Active')).toHaveLength(1);
  });

  it('warns when no telemetry endpoint is configured, and not otherwise', async () => {
    const api = new TelemetryApi();
    api.status = telemetryStatus({ dsnConfigured: false });
    await renderTab(api);
    expect(screen.getByText(/No telemetry endpoint is configured/)).toBeDefined();
    expect(screen.getByText('COSTGOBLIN_SENTRY_DSN')).toBeDefined();
  });

  it('does not warn about the endpoint once one is configured', async () => {
    await renderTab(new TelemetryApi());
    expect(screen.queryByText(/No telemetry endpoint is configured/)).toBeNull();
  });

  it('saves a toggle and asks for a restart when the reporter is not running yet', async () => {
    const api = new TelemetryApi();
    const user = await renderTab(api);

    await user.click(toggle('Error reports'));

    expect(api.saves).toEqual([{ ...ALL_OFF, errorReports: true }]);
    expect(isOn('Error reports')).toBe(true);
    expect(await screen.findByText(RESTART_PROMPT)).toBeDefined();
  });

  it('turns error reports on live, without a restart, while the reporter already runs', async () => {
    const api = new TelemetryApi();
    api.prefs = { ...ALL_OFF, performance: true };
    api.status = telemetryStatus({ active: true });
    const user = await renderTab(api);

    await user.click(toggle('Error reports'));

    expect(api.saves).toEqual([{ ...ALL_OFF, performance: true, errorReports: true }]);
    await waitFor(() => { expect(isDisabled(toggle('Error reports'))).toBe(false); });
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();
  });

  it('needs a restart for performance tracing even while the reporter runs', async () => {
    const api = new TelemetryApi();
    api.prefs = { ...ALL_OFF, errorReports: true };
    api.status = telemetryStatus({ active: true });
    const user = await renderTab(api);

    await user.click(toggle('Performance metrics'));

    expect(api.saves).toEqual([{ ...ALL_OFF, errorReports: true, performance: true }]);
    expect(await screen.findByText(RESTART_PROMPT)).toBeDefined();
  });

  it('applies a disable live, without a restart', async () => {
    const api = new TelemetryApi();
    api.prefs = { ...ALL_OFF, performance: true };
    const user = await renderTab(api);

    await user.click(toggle('Performance metrics'));

    expect(api.saves).toEqual([ALL_OFF]);
    expect(isOn('Performance metrics')).toBe(false);
    await waitFor(() => { expect(isDisabled(toggle('Performance metrics'))).toBe(false); });
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();
  });

  it('judges the next toggle against the refreshed status, not the one it loaded with', async () => {
    const api = new TelemetryApi();
    api.prefs = { ...ALL_OFF, errorReports: true };
    api.status = telemetryStatus({ active: true });
    const user = await renderTab(api);

    // Turning off the last channel shuts the reporter down…
    api.status = telemetryStatus({ active: false });
    await user.click(toggle('Error reports'));
    await waitFor(() => { expect(isDisabled(toggle('Error reports'))).toBe(false); });
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();

    // …so turning it back on now needs a restart.
    await user.click(toggle('Error reports'));
    expect(await screen.findByText(RESTART_PROMPT)).toBeDefined();
    expect(api.saves).toEqual([ALL_OFF, { ...ALL_OFF, errorReports: true }]);
  });

  it('locks every switch while a save is in flight', async () => {
    const api = new TelemetryApi();
    const save = deferred();
    api.saveOutcome = () => save.promise;
    const user = await renderTab(api);

    await user.click(toggle('Error reports'));
    for (const label of CHANNELS) expect(isDisabled(toggle(label))).toBe(true);

    await act(async () => { save.resolve(); await save.promise; });
    await waitFor(() => { expect(isDisabled(toggle('Error reports'))).toBe(false); });
    expect(isDisabled(toggle('Performance metrics'))).toBe(false);
  });

  it('reverts the switch when the save is rejected', async () => {
    const api = new TelemetryApi();
    api.saveOutcome = () => Promise.reject(new Error('disk full'));
    const user = await renderTab(api);

    await user.click(toggle('Error reports'));

    await waitFor(() => { expect(isOn('Error reports')).toBe(false); });
    expect(isDisabled(toggle('Error reports'))).toBe(false);
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();
  });

  it('keeps a persisted toggle when only the status refresh afterwards fails', async () => {
    const api = new TelemetryApi();
    const user = await renderTab(api);
    vi.spyOn(api, 'getTelemetryStatus').mockRejectedValue(new Error('ipc down'));

    await user.click(toggle('Error reports'));

    expect(await screen.findByText(RESTART_PROMPT)).toBeDefined();
    expect(isOn('Error reports')).toBe(true);
    await waitFor(() => { expect(isDisabled(toggle('Error reports'))).toBe(false); });
  });

  it('restarts the app from the prompt, or dismisses it for later', async () => {
    const relaunch = vi.spyOn(fakeUpdate, 'relaunch');
    const api = new TelemetryApi();
    const user = await renderTab(api);
    await user.click(toggle('Error reports'));
    await screen.findByText(RESTART_PROMPT);

    await user.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(relaunch).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();
  });

  describe('native crash reports', () => {
    const CONFIRM = 'Enable native crash reports';

    it('asks for explicit consent before saving anything', async () => {
      const api = new TelemetryApi();
      const user = await renderTab(api);

      await user.click(toggle('Native crash reports'));

      expect(screen.getByText('Enable native crash reports?')).toBeDefined();
      expect(isOn('Native crash reports')).toBe(false);
      expect(api.saves).toEqual([]);
    });

    it('saves only once consent is given, and then needs a restart', async () => {
      const api = new TelemetryApi();
      // Even with the reporter running: a dump handler can only arm at boot.
      api.status = telemetryStatus({ active: true });
      const user = await renderTab(api);
      await user.click(toggle('Native crash reports'));

      await user.click(screen.getByRole('button', { name: CONFIRM }));

      expect(api.saves).toEqual([{ ...ALL_OFF, nativeCrashReports: true }]);
      expect(screen.queryByText('Enable native crash reports?')).toBeNull();
      expect(isOn('Native crash reports')).toBe(true);
      expect(await screen.findByText(RESTART_PROMPT)).toBeDefined();
    });

    it('cancelling the consent leaves the channel off and unsaved', async () => {
      const api = new TelemetryApi();
      const user = await renderTab(api);
      await user.click(toggle('Native crash reports'));

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Enable native crash reports?')).toBeNull();
      expect(isOn('Native crash reports')).toBe(false);
      expect(api.saves).toEqual([]);
    });

    it('cannot be confirmed while another channel is still saving', async () => {
      const api = new TelemetryApi();
      const save = deferred();
      api.saveOutcome = () => save.promise;
      const user = await renderTab(api);
      await user.click(toggle('Native crash reports'));

      await user.click(toggle('Error reports'));
      const confirm = screen.getByRole('button', { name: CONFIRM });
      expect(isDisabled(confirm)).toBe(true);

      await act(async () => { save.resolve(); await save.promise; });
      await waitFor(() => { expect(isDisabled(screen.getByRole('button', { name: CONFIRM }))).toBe(false); });
    });

    it('turns off without asking again', async () => {
      const api = new TelemetryApi();
      api.prefs = { ...ALL_OFF, nativeCrashReports: true };
      const user = await renderTab(api);

      await user.click(toggle('Native crash reports'));

      expect(screen.queryByText('Enable native crash reports?')).toBeNull();
      expect(api.saves).toEqual([ALL_OFF]);
      expect(isOn('Native crash reports')).toBe(false);
    });
  });

  describe('audit log', () => {
    function entry(kind: TelemetryOutboxEntry['kind'], title: string, timestamp: string): TelemetryOutboxEntry {
      return { timestamp, eventId: null, level: null, kind, title };
    }

    it('says nothing has been sent while the log is empty', async () => {
      await renderTab(new TelemetryApi());
      expect(screen.getByText('Nothing has been sent.')).toBeDefined();
      expect(screen.queryByRole('listitem')).toBeNull();
    });

    it('lists each sent event with its kind, title and local time', async () => {
      const api = new TelemetryApi();
      api.outbox = [
        entry('error', 'TypeError: x is undefined', '2026-01-15T09:30:00.000Z'),
        entry('transaction', 'GET /dashboard', '2026-01-15T09:31:00.000Z'),
        entry('session', 'session update', '2026-01-15T09:32:00.000Z'),
        entry('crash', 'Native crash (minidump)', '2026-01-15T09:33:00.000Z'),
        entry('other', 'client report', '2026-01-15T09:34:00.000Z'),
      ];
      await renderTab(api);

      const items = screen.getAllByRole('listitem');
      // Each entry leads with its kind badge.
      expect(items.map(item => item.firstElementChild?.textContent)).toEqual(['Error', 'Trace', 'Session', 'Crash', 'Event']);
      const first = items[0];
      if (first === undefined) throw new Error('no audit entries');
      expect(within(first).getByText('TypeError: x is undefined')).toBeDefined();
      expect(within(first).getByText(new Date('2026-01-15T09:30:00.000Z').toLocaleString())).toBeDefined();
      expect(screen.queryByText('Nothing has been sent.')).toBeNull();
    });

    it('Refresh re-reads the log', async () => {
      const api = new TelemetryApi();
      const user = await renderTab(api);
      api.outbox = [entry('error', 'RangeError: late', '2026-01-15T10:00:00.000Z')];

      await user.click(screen.getByRole('button', { name: 'Refresh' }));

      expect(await screen.findByText('RangeError: late')).toBeDefined();
    });

    it('keeps the current list when a refresh fails', async () => {
      const api = new TelemetryApi();
      api.outbox = [entry('error', 'Error: kept', '2026-01-15T10:00:00.000Z')];
      const user = await renderTab(api);
      const read = vi.spyOn(api, 'getTelemetryOutbox').mockRejectedValue(new Error('ipc down'));

      await user.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => { expect(read).toHaveBeenCalledOnce(); });
      expect(screen.getByText('Error: kept')).toBeDefined();
    });
  });
});
