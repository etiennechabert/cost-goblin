import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExplorerPreferences } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ExplorerView } from '../views/explorer.js';

// The desktop `explorer:get-preferences` handler owns the first-run contract:
// with no prefs file on disk it returns DEFAULT_EXPLORER_HIDDEN_COLUMNS
// (MockCostApi mirrors that), while a persisted `hiddenColumns: []` is the
// user's explicit "Show all". The view applies whatever the handler returns
// verbatim, so these tests pin both halves of that contract.

afterEach(cleanup);

// Display labels of the DEFAULT_EXPLORER_HIDDEN_COLUMNS ids, minus
// `usage_hour` ("Hour") which the daily granularity drops from the column
// set before visibility preferences even apply.
const DEFAULT_HIDDEN_LABELS = ['List', 'Service', 'Usage', 'Operation'];

class PrefsApi extends MockCostApi {
  private readonly prefs: ExplorerPreferences;
  constructor(prefs: ExplorerPreferences) {
    super();
    this.prefs = prefs;
  }
  override getExplorerPreferences(): Promise<ExplorerPreferences> {
    return Promise.resolve(this.prefs);
  }
}

class FailingPrefsApi extends MockCostApi {
  override getExplorerPreferences(): Promise<ExplorerPreferences> {
    return Promise.reject(new Error('prefs unavailable'));
  }
}

function renderExplorer(api: MockCostApi) {
  return render(
    <CostApiProvider value={api}>
      <ExplorerView />
    </CostApiProvider>,
  );
}

/** Column header labels, with the sort-arrow glyph the sortable-header
 *  button appends stripped so labels compare exactly. */
async function headerLabels(): Promise<string[]> {
  await waitFor(() => {
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
  }, { timeout: 3000 });
  return screen.getAllByRole('columnheader')
    .map(h => h.textContent.replace(/[↑↓↕]/gu, '').trim());
}

describe('ExplorerView column visibility', () => {
  it('hides the default column set on a fresh profile (first-run prefs)', async () => {
    renderExplorer(new MockCostApi());
    const headers = await headerLabels();
    expect(headers).toContain('Date');
    expect(headers).toContain('Charge Category');
    expect(headers).toContain('Service Category');
    for (const label of DEFAULT_HIDDEN_LABELS) {
      expect(headers).not.toContain(label);
    }
  });

  it('shows every column when the user saved an explicit "Show all"', async () => {
    renderExplorer(new PrefsApi({ hiddenColumns: [], columnOrder: [] }));
    const headers = await headerLabels();
    for (const label of DEFAULT_HIDDEN_LABELS) {
      expect(headers).toContain(label);
    }
  });

  it('honors a saved custom hidden set', async () => {
    renderExplorer(new PrefsApi({ hiddenColumns: ['region', 'description'], columnOrder: [] }));
    const headers = await headerLabels();
    expect(headers).not.toContain('Region');
    expect(headers).not.toContain('Description');
    expect(headers).toContain('Operation');
  });

  it('keeps the default hidden set when preferences fail to load', async () => {
    renderExplorer(new FailingPrefsApi());
    const headers = await headerLabels();
    expect(headers).toContain('Date');
    for (const label of DEFAULT_HIDDEN_LABELS) {
      expect(headers).not.toContain(label);
    }
  });
});
