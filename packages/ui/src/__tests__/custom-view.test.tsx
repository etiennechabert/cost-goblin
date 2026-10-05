import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { DEFAULT_COST_SCOPE, asDimensionId } from '@costgoblin/core/browser';
import type { CostQueryParams, CostResult, CostScopeConfig, ViewSpec } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CustomView } from '../views/custom-view.js';
import { getDefaultDateRange } from '../components/date-range-picker.js';
import { daysAgo, daysBetween } from '../lib/dates.js';


const SPEC: ViewSpec = {
  id: 'test',
  name: 'Test View',
  rows: [
    {
      widgets: [
        { id: 's1', type: 'summary', size: 'small', metric: 'total' },
        { id: 'p1', type: 'pie', size: 'medium', groupBy: asDimensionId('service') },
      ],
    },
    {
      widgets: [
        { id: 't1', type: 'topNBar', size: 'large', groupBy: asDimensionId('account'), topN: 5 },
      ],
    },
  ],
};

afterEach(cleanup);

function renderView(spec: ViewSpec = SPEC) {
  return render(
    <PaletteProvider>
      <CostApiProvider value={new MockCostApi()}>
        <CustomView spec={spec} headerSubtitle="hello" />
      </CostApiProvider>
    </PaletteProvider>,
  );
}

describe('CustomView', () => {
  it('renders the summary card after data loads', async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });
  });

  it('does not crash with an empty spec', () => {
    const empty: ViewSpec = { id: 'e', name: 'Empty', rows: [] };
    expect(() => renderView(empty)).not.toThrow();
    expect(screen.getByText('Empty')).toBeDefined();
  });

  it('does not persist anything on a clean mount (no clobbering the shared file)', async () => {
    const api = new MockCostApi();
    render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <CustomView spec={SPEC} headerSubtitle="hello" />
        </CostApiProvider>
      </PaletteProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });
    // Wait past the 500ms save debounce before asserting. Without this the
    // test is vacuous — it would read the empty log long before a scheduled
    // mount-time write could fire, and would still pass with the guard gone.
    await new Promise(resolve => setTimeout(resolve, 700));
    // Opening the view restores nothing, so it must not write — otherwise it
    // would overwrite the shared explorer-preferences file just by being shown.
    expect(api.savedExplorerPreferences).toHaveLength(0);
  });

  it('persists date range / granularity / compare, never the column fields', async () => {
    const api = new MockCostApi();
    const user = userEvent.setup();
    render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <CustomView spec={SPEC} headerSubtitle="hello" />
        </CostApiProvider>
      </PaletteProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });

    // Change the date range to trigger the debounced save.
    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    await user.click(screen.getByRole('button', { name: 'Last 90 days' }));

    await waitFor(() => {
      expect(api.savedExplorerPreferences.length).toBeGreaterThan(0);
    }, { timeout: 2000 });

    // The save carries the session state but never the column fields — the
    // desktop handler merges, so omitting them preserves the Explorer's set.
    for (const prefs of api.savedExplorerPreferences) {
      expect('hiddenColumns' in prefs).toBe(false);
      expect('columnOrder' in prefs).toBe(false);
    }
    // Pin the range the user actually picked. Asserting only granularity /
    // compareEnabled would be a tautology — both are still their initial
    // values, so they'd hold even if the range were never persisted.
    const saved = api.savedExplorerPreferences.at(-1);
    expect(saved?.lastUsedDateRange).toBeDefined();
    const range = saved?.lastUsedDateRange;
    if (range !== undefined) {
      expect(daysBetween(range.start, range.end)).toBe(91); // "Last 90 days"
    }
    expect(saved?.lastUsedGranularity).toBe('daily');
    expect(saved?.compareEnabled).toBe(false);
  });
});

/** Records the range of every queryCosts call (the pie and top-N widgets),
 *  i.e. the range the view actually committed. */
class RecordingCostsApi extends MockCostApi {
  readonly costCalls: CostQueryParams[] = [];
  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    if (params !== undefined) this.costCalls.push(params);
    return super.queryCosts();
  }
}

const LAG_5_SCOPE: CostScopeConfig = { ...DEFAULT_COST_SCOPE, lagDays: 5 };

describe('CustomView with a configured lag', () => {
  // Pin the clock so the range the view seeds and the one each assertion
  // recomputes can't straddle a UTC midnight. Only Date is faked: the save
  // debounce and waitFor need real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on the default window for the configured lag, without persisting it', async () => {
    const api = new RecordingCostsApi();
    api.getCostScope = () => Promise.resolve(LAG_5_SCOPE);
    render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <CustomView spec={SPEC} headerSubtitle="hello" />
        </CostApiProvider>
      </PaletteProvider>,
    );

    await waitFor(() => {
      expect(api.costCalls.at(-1)?.dateRange).toEqual(getDefaultDateRange(5));
    });
    // The picker's presets use the same lag, so the committed range reads as
    // its "Last 30 days" rather than as raw dates.
    expect(screen.getByRole('button', { name: /Last 30 days/ })).toBeDefined();

    // Re-seeding for the lag is still the clean-mount default, not a change
    // the user made: past the 500ms debounce, nothing may reach the shared file.
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(api.savedExplorerPreferences).toHaveLength(0);
  });

  it('keeps a range the user picked before the configured lag arrived', async () => {
    const api = new RecordingCostsApi();
    const scopeReads: ((scope: CostScopeConfig) => void)[] = [];
    api.getCostScope = () => new Promise(resolve => { scopeReads.push(resolve); });
    const user = userEvent.setup();
    render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <CustomView spec={SPEC} headerSubtitle="hello" />
        </CostApiProvider>
      </PaletteProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });

    // Picked while the default lag (2) is still in force.
    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    await user.click(screen.getByRole('button', { name: 'Last 90 days' }));
    const picked = { start: daysAgo(92), end: daysAgo(2) };
    await waitFor(() => {
      expect(api.costCalls.at(-1)?.dateRange).toEqual(picked);
    });

    await act(async () => {
      for (const resolve of scopeReads) resolve(LAG_5_SCOPE);
      await Promise.resolve();
    });
    // Give a wrongful re-seed the chance to commit and re-query.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(api.costCalls.at(-1)?.dateRange).toEqual(picked);
  });
});
