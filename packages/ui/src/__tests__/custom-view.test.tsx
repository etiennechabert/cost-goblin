import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { ExplorerPreferencesUpdate, ViewSpec } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CustomView } from '../views/custom-view.js';

/** Records every preferences write so the test can assert the payload shape. */
class RecordingPrefsApi extends MockCostApi {
  readonly saved: ExplorerPreferencesUpdate[] = [];
  override saveExplorerPreferences(prefs?: ExplorerPreferencesUpdate): Promise<void> {
    if (prefs !== undefined) this.saved.push(prefs);
    return Promise.resolve();
  }
}

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
    const api = new RecordingPrefsApi();
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
    // Opening the view restores nothing, so it must not write — otherwise it
    // would overwrite the shared explorer-preferences file just by being shown.
    expect(api.saved).toHaveLength(0);
  });

  it('persists date range / granularity / compare, never the column fields', async () => {
    const api = new RecordingPrefsApi();
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
      expect(api.saved.length).toBeGreaterThan(0);
    }, { timeout: 2000 });

    // The save carries the session state but never the column fields — the
    // desktop handler merges, so omitting them preserves the Explorer's set.
    for (const prefs of api.saved) {
      expect('hiddenColumns' in prefs).toBe(false);
      expect('columnOrder' in prefs).toBe(false);
    }
    expect(api.saved.at(-1)?.lastUsedGranularity).toBe('daily');
    expect(api.saved.at(-1)?.compareEnabled).toBe(false);
  });
});
