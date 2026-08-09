import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ExplorerPreferences } from '@costgoblin/core/browser';
import { asDateString } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { EntityDetail } from '../views/entity-detail.js';

/** Serves a non-empty hidden set plus a restorable date range: the restore
 *  triggers a save, and MockCostApi's recorded payloads then let us prove the
 *  view never echoes the column fields back. */
class RecordingPrefsApi extends MockCostApi {
  override getExplorerPreferences(): Promise<ExplorerPreferences> {
    return Promise.resolve({
      hiddenColumns: ['region', 'description'],
      columnOrder: ['cost', 'service'],
      lastUsedDateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
      lastUsedGranularity: 'daily',
    });
  }
}

function renderDetail(overrides?: Partial<{ onBack: () => void }>) {
  const api = new MockCostApi();
  const onBack = overrides?.onBack ?? vi.fn();
  const user = userEvent.setup();
  return {
    api,
    onBack,
    user,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <EntityDetail entity="platform" dimension="account" onBack={onBack} />
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

afterEach(cleanup);

describe('EntityDetail', () => {
  it('shows histogram with Groups/Products/Services tabs after data loads', async () => {
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });

    expect(screen.getByRole('button', { name: 'Groups' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Products' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Services' })).toBeDefined();
  });

  it('histogram tab toggle switches active state', async () => {
    const { user } = renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });

    const groupsBtn = screen.getByRole('button', { name: 'Groups' });
    const servicesBtn = screen.getByRole('button', { name: 'Services' });

    await user.click(groupsBtn);
    expect(groupsBtn.className).toContain('bg-accent');

    await user.click(servicesBtn);
    expect(servicesBtn.className).toContain('bg-accent');
  });

  it('back button calls onBack', async () => {
    const onBack = vi.fn();
    const { user } = renderDetail({ onBack });

    const backBtn = screen.getByRole('button', { name: /Back/i });
    await user.click(backBtn);

    expect(onBack).toHaveBeenCalledOnce();
  });

  it('export CSV button is visible when data loads', async () => {
    renderDetail();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Export CSV/i })).toBeDefined();
    });
  });

  it('persists only the date range / granularity, never the column fields', async () => {
    const api = new RecordingPrefsApi();
    render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <EntityDetail entity="platform" dimension="account" onBack={vi.fn()} />
        </CostApiProvider>
      </PaletteProvider>,
    );

    // Restoring the persisted range triggers exactly one save.
    await waitFor(() => {
      expect(api.savedExplorerPreferences.length).toBeGreaterThan(0);
    });

    // The view doesn't manage columns, so a save must omit hiddenColumns /
    // columnOrder entirely — otherwise it could clobber the Explorer's set.
    for (const prefs of api.savedExplorerPreferences) {
      expect('hiddenColumns' in prefs).toBe(false);
      expect('columnOrder' in prefs).toBe(false);
    }
    expect(api.savedExplorerPreferences.at(-1)?.lastUsedDateRange).toEqual({ start: '2026-01-01', end: '2026-01-31' });
    expect(api.savedExplorerPreferences.at(-1)?.lastUsedGranularity).toBe('daily');
  });
});
