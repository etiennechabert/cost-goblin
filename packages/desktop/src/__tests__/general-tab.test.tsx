import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateInfo, UpdateStatus } from '@costgoblin/core/browser';
import { PALETTE_COLORBLIND, PALETTE_STANDARD } from '@costgoblin/ui';
import { GeneralTab } from '../renderer/settings/general-tab.js';

type Props = Parameters<typeof GeneralTab>[0];

const INFO: UpdateInfo = { version: '1.4.0', releaseDate: '2026-01-20', releaseNotes: null };

function props(overrides: Partial<Props> = {}): Props {
  return {
    isDark: true,
    onToggleTheme: vi.fn(),
    palette: 'standard',
    onTogglePalette: vi.fn(),
    dashboards: [{ id: 'overview', name: 'Overview' }, { id: 'costs', name: 'Team costs' }],
    defaultViewId: 'overview',
    onSetDefaultView: vi.fn(),
    appVersion: '0.8.10',
    updateStatus: { state: 'idle' },
    updateChecked: false,
    checkOnStartup: true,
    onSetCheckOnStartup: vi.fn(),
    onCheckForUpdates: vi.fn(),
    onShowReleaseNotes: vi.fn(),
    onRerunSetup: vi.fn(),
    ...overrides,
  };
}

function renderTab(overrides: Partial<Props> = {}): { user: ReturnType<typeof userEvent.setup>; props: Props } {
  const p = props(overrides);
  const user = userEvent.setup();
  render(<GeneralTab {...p} />);
  return { user, props: p };
}

function pressed(name: string): boolean {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';
}

function defaultDashboard(): HTMLSelectElement {
  const select = screen.getByRole('combobox', { name: 'Default dashboard' });
  if (!(select instanceof HTMLSelectElement)) throw new Error('Default dashboard is not a <select>');
  return select;
}

describe('GeneralTab', () => {
  it('switches theme only when the other option is picked', async () => {
    const { user, props: p } = renderTab({ isDark: true });
    expect(pressed('Dark')).toBe(true);
    expect(pressed('Light')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(p.onToggleTheme).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(p.onToggleTheme).toHaveBeenCalledOnce();
  });

  it('marks Light when the light theme is on', () => {
    renderTab({ isDark: false });
    expect(pressed('Light')).toBe(true);
    expect(pressed('Dark')).toBe(false);
  });

  it.each([
    { palette: 'standard' as const, swatches: PALETTE_STANDARD, other: 'Colorblind', announced: 'Standard chart palette active' },
    { palette: 'colorblind' as const, swatches: PALETTE_COLORBLIND, other: 'Standard', announced: 'Colorblind-safe chart palette active' },
  ])('previews and announces the $palette palette, and switches to $other', async ({ palette, swatches, other, announced }) => {
    const { user, props: p } = renderTab({ palette });

    // The swatch strip is the decorative (aria-hidden) part of the palette row.
    const preview = screen.getByText('Chart palette').closest('div.flex')?.querySelector('[aria-hidden="true"]');
    const colors = [...(preview?.querySelectorAll('span') ?? [])].map(swatch => swatch.style.backgroundColor);
    const expected = swatches.map((hex) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = hex;
      return probe.style.backgroundColor;
    });
    expect(colors).toEqual(expected);
    expect(screen.getByText(announced)).toBeDefined();

    await user.click(screen.getByRole('button', { name: other }));
    expect(p.onTogglePalette).toHaveBeenCalledOnce();
  });

  it('picks the default dashboard from the list', async () => {
    const { user, props: p } = renderTab();
    expect(defaultDashboard().value).toBe('overview');
    expect([...defaultDashboard().options].map(o => o.textContent)).toEqual(['Overview', 'Team costs']);

    await user.selectOptions(defaultDashboard(), 'Team costs');
    expect(p.onSetDefaultView).toHaveBeenCalledWith('costs');
  });

  it('still lets a new default be picked when the saved one no longer exists', async () => {
    const { user, props: p } = renderTab({ defaultViewId: 'deleted-view' });
    expect([...defaultDashboard().options].map(o => o.value)).toEqual(['overview', 'costs']);

    await user.selectOptions(defaultDashboard(), 'Team costs');
    expect(p.onSetDefaultView).toHaveBeenCalledWith('costs');
  });

  it.each([
    { checkOnStartup: true, active: 'Automatic', pick: 'Manual only', saved: false },
    { checkOnStartup: false, active: 'Manual only', pick: 'Automatic', saved: true },
  ])('saves the update-check preference ($active → $pick)', async ({ checkOnStartup, active, pick, saved }) => {
    const { user, props: p } = renderTab({ checkOnStartup });
    expect(pressed(active)).toBe(true);

    await user.click(screen.getByRole('button', { name: pick }));
    expect(p.onSetCheckOnStartup).toHaveBeenCalledWith(saved);
  });

  describe('software updates', () => {
    it.each<{ status: UpdateStatus; label: string; action: 'notes' | 'check' }>([
      { status: { state: 'available', info: INFO }, label: 'v1.4.0 available', action: 'notes' },
      { status: { state: 'downloading', percent: 42, info: INFO }, label: 'Downloading 42%', action: 'notes' },
      { status: { state: 'downloaded', info: INFO }, label: 'Restart to install', action: 'notes' },
      { status: { state: 'error', error: 'net::ERR_TIMED_OUT', stage: 'check', logs: [] }, label: 'Retry update check', action: 'check' },
      { status: { state: 'idle' }, label: 'Check for updates', action: 'check' },
    ])('offers "$label" while $status.state', async ({ status, label, action }) => {
      const { user, props: p } = renderTab({ updateStatus: status });

      await user.click(screen.getByRole('button', { name: label }));

      if (action === 'notes') {
        expect(p.onShowReleaseNotes).toHaveBeenCalledOnce();
        expect(p.onCheckForUpdates).not.toHaveBeenCalled();
      } else {
        expect(p.onCheckForUpdates).toHaveBeenCalledOnce();
        expect(p.onShowReleaseNotes).not.toHaveBeenCalled();
      }
    });

    it('shows a check in progress without a button', () => {
      renderTab({ updateStatus: { state: 'checking' } });
      expect(screen.getByText('Checking…')).toBeDefined();
      expect(screen.queryByRole('button', { name: /Check for updates|Retry update check/ })).toBeNull();
      // The row's own control already says what is happening.
      expect(screen.queryByText(/up to date|Not checked yet|Automatic check is off/)).toBeNull();
    });

    it('says the app is up to date after a check, with the running version', () => {
      renderTab({ updateChecked: true });
      expect(screen.getByText("You're up to date · v0.8.10")).toBeDefined();
      expect(screen.getByText('Version')).toBeDefined();
      expect(screen.getByText('v0.8.10')).toBeDefined();
    });

    it('hides the version row until the version is known', () => {
      renderTab({ appVersion: '' });
      expect(screen.queryByText('Version')).toBeNull();
    });

    it('hides the version row while an update is available', () => {
      renderTab({ updateStatus: { state: 'available', info: INFO } });
      expect(screen.queryByText('Version')).toBeNull();
    });
  });

  it('re-runs the setup wizard on request', async () => {
    const { user, props: p } = renderTab();
    await user.click(screen.getByRole('button', { name: 'Run setup again' }));
    expect(p.onRerunSetup).toHaveBeenCalledOnce();
  });
});
