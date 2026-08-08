import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect } from 'vitest';
import type {
  CostGoblinConfig,
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerRowsParams,
  ExplorerRowsResult,
} from '@costgoblin/core/browser';
import { asBucketPath, asProviderName } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ExplorerView } from '../views/explorer.js';
import { daysAgo } from '../lib/dates.js';

/** Mirrors the view's DEFAULT_HIDDEN set, served as *saved* preferences.
 *  The prefs response is authoritative (the view overwrites its initial
 *  hidden state with it), and any real profile that has saved once carries
 *  exactly this list — so this is the representative loaded state. */
const SAVED_HIDDEN = ['usage_hour', 'list_cost', 'service', 'usage_amount', 'operation'];

/** Deterministic histogram: 10 daily buckets, 2026-03-01 → 2026-03-10.
 *  The drag-select tests depend on the bar count and dates. */
const FIXED_DAILY_TOTALS = Array.from({ length: 10 }, (_, i) => ({
  date: `2026-03-${String(i + 1).padStart(2, '0')}`,
  cost: 1_000 + i * 10,
  rows: 100 + i,
}));

const FIXED_OVERVIEW: ExplorerOverviewResult = {
  windowDays: 10,
  startDate: '2026-03-01',
  endDate: '2026-03-10',
  dailyTotals: FIXED_DAILY_TOTALS,
  totalRows: 54_012,
  totalCost: 12_345.67,
  tagColumns: [
    { id: 'tag_team', label: 'Team' },
    { id: 'tag_env', label: 'Environment' },
  ],
};

/** The view's default range: last 30 days ending at the lag cutoff
 *  (DEFAULT_LAG_DAYS = 2, the mock cost scope sets no override). */
function defaultRange(): { start: string; end: string } {
  return { start: daysAgo(32), end: daysAgo(2) };
}

/** Captures every Explorer query payload and serves deterministic data.
 *  The base MockCostApi methods take no parameters (so their declared
 *  types drop them); these overrides re-declare the params as optional to
 *  stay override-compatible while recording what the view actually sent. */
class ExplorerMockApi extends MockCostApi {
  readonly overviewCalls: ExplorerOverviewParams[] = [];
  readonly rowsCalls: ExplorerRowsParams[] = [];
  readonly filterValueCalls: ExplorerFilterValuesParams[] = [];
  readonly savedPreferences: ExplorerPreferences[] = [];

  override queryExplorerOverview(params?: ExplorerOverviewParams): Promise<ExplorerOverviewResult> {
    if (params !== undefined) this.overviewCalls.push(params);
    return Promise.resolve(FIXED_OVERVIEW);
  }

  override queryExplorerRows(params?: ExplorerRowsParams): Promise<ExplorerRowsResult> {
    if (params !== undefined) this.rowsCalls.push(params);
    return super.queryExplorerRows();
  }

  override getExplorerFilterValues(params?: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]> {
    if (params !== undefined) this.filterValueCalls.push(params);
    return super.getExplorerFilterValues();
  }

  override getExplorerPreferences(): Promise<ExplorerPreferences> {
    return Promise.resolve({ hiddenColumns: SAVED_HIDDEN, columnOrder: [] });
  }

  override saveExplorerPreferences(prefs?: ExplorerPreferences): Promise<void> {
    if (prefs !== undefined) this.savedPreferences.push(prefs);
    return Promise.resolve();
  }
}

/** An AWS provider with an hourly tier — flips useHourlyConfigured to true. */
const HOURLY_CONFIG: CostGoblinConfig = {
  providers: [
    {
      name: asProviderName('aws-main'),
      type: 'aws',
      credentialsProfile: 'default',
      sync: {
        daily: { bucket: asBucketPath('costgoblin-cur-bucket/daily'), retentionDays: 90 },
        hourly: { bucket: asBucketPath('costgoblin-cur-bucket/hourly'), retentionDays: 30 },
        intervalMinutes: 60,
      },
    },
  ],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

function renderExplorer(api?: ExplorerMockApi) {
  const mockApi = api ?? new ExplorerMockApi();
  const user = userEvent.setup();
  return {
    api: mockApi,
    user,
    ...render(
      <CostApiProvider value={mockApi}>
        <ExplorerView />
      </CostApiProvider>,
    ),
  };
}

/** Table header labels, sort arrows stripped. */
function visibleHeaders(): string[] {
  const table = screen.getByRole('table');
  return within(table)
    .getAllByRole('columnheader')
    .map(th => th.textContent.replace(/[↑↓↕]/g, '').trim());
}

/** Simulate a horizontal drag across the histogram bars. The bars container
 *  is the only div with role="button"; jsdom reports zero-size rects, so pin
 *  a 300px-wide rect (10 bars → 30px per bar) before dispatching. */
function dragHistogram(fromX: number, toX: number): void {
  const bars = document.querySelector('div[role="button"]');
  expect(bars).not.toBeNull();
  if (bars === null) return;
  bars.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
  fireEvent.mouseDown(bars, { clientX: fromX, clientY: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: toX, clientY: 100 });
  fireEvent.mouseUp(window);
}

afterEach(cleanup);

describe('ExplorerView', () => {
  describe('initial load', () => {
    it('fires one overview and one rows query with the default payloads', async () => {
      const { api } = renderExplorer();
      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(1);
        expect(api.rowsCalls).toHaveLength(1);
      });
      expect(api.overviewCalls[0]).toEqual({
        filters: {},
        dateRange: defaultRange(),
        granularity: 'daily',
        applyCostScope: false,
        costMetric: 'effective',
        origin: 'explorer:overview',
      });
      expect(api.rowsCalls[0]).toEqual({
        filters: {},
        rowLimit: 500,
        dateRange: defaultRange(),
        granularity: 'daily',
        applyCostScope: false,
        costMetric: 'effective',
        origin: 'explorer:rows',
      });
    });

    it('renders the histogram, the totals line, and the sample table', async () => {
      renderExplorer();
      const bars = await screen.findAllByRole('img');
      expect(bars).toHaveLength(10);
      expect(bars[0]?.getAttribute('aria-label')).toContain('2026-03-01');

      const totals = await screen.findByText(/line items/);
      expect(totals.textContent).toContain((54_012).toLocaleString());
      expect(totals.textContent).toContain('2026-03-01 → 2026-03-10');

      const table = await screen.findByRole('table');
      expect(within(table).getByText('EUC1-BoxUsage:t3.medium')).toBeDefined();
      expect(within(table).getAllByText('prod-main').length).toBeGreaterThan(0);
      // The row counter reports the sample honestly against the full dataset.
      expect(screen.getByText(/Showing/).textContent).toContain((54_012).toLocaleString());
    });
  });

  describe('columns', () => {
    it('hides the persisted hidden set and renders the rest in default order', async () => {
      renderExplorer();
      await screen.findByRole('table');
      expect(visibleHeaders()).toEqual([
        'Date', 'Charge Category', 'Cost', 'Service Category', 'Region',
        'Account', 'Resource', 'Description', 'SKU Meter', 'Team', 'Environment',
      ]);
    });

    it('re-showing and hiding columns via the picker updates the table and persists', async () => {
      const { api, user } = renderExplorer();
      await screen.findByRole('table');
      await user.click(screen.getByRole('button', { name: /^Columns/ }));

      await user.click(screen.getByRole('checkbox', { name: /Operation/ }));
      await waitFor(() => {
        expect(visibleHeaders()).toContain('Operation');
      });
      expect(api.savedPreferences.at(-1)).toEqual({
        hiddenColumns: ['usage_hour', 'list_cost', 'service', 'usage_amount'],
        columnOrder: [],
        lastUsedDateRange: defaultRange(),
        lastUsedGranularity: 'daily',
      });

      await user.click(screen.getByRole('checkbox', { name: /Region/ }));
      await waitFor(() => {
        expect(visibleHeaders()).not.toContain('Region');
      });
      expect(api.savedPreferences.at(-1)?.hiddenColumns).toEqual(
        ['usage_hour', 'list_cost', 'service', 'usage_amount', 'region'],
      );
    });
  });

  describe('filters', () => {
    it('clicking a dimension cell adds that value as a filter, re-queries, and auto-hides the pinned column', async () => {
      const { api, user } = renderExplorer();
      await screen.findByRole('table');

      const regionCell = screen.getAllByRole('button', { name: 'eu-central-1' })[0];
      expect(regionCell).toBeDefined();
      if (regionCell === undefined) return;
      await user.click(regionCell);

      await waitFor(() => {
        expect(api.rowsCalls).toHaveLength(2);
        expect(api.overviewCalls).toHaveLength(2);
      });
      expect(api.rowsCalls[1]?.filters).toEqual({ region: ['eu-central-1'] });
      expect(api.overviewCalls[1]?.filters).toEqual({ region: ['eu-central-1'] });

      // The chip reflects the active filter…
      expect(screen.getByText('Region: eu-central-1')).toBeDefined();
      // …and the column is auto-hidden while pinned to a single value.
      await screen.findByRole('table');
      expect(visibleHeaders()).not.toContain('Region');

      await user.click(screen.getByText(/Clear all/));
      await waitFor(() => {
        expect(api.rowsCalls).toHaveLength(3);
      });
      expect(api.rowsCalls[2]?.filters).toEqual({});
      await screen.findByRole('table');
      expect(visibleHeaders()).toContain('Region');
    });

    it('the filter chip dropdown queries values with the current context and applies the selection', async () => {
      const { api, user } = renderExplorer();
      await screen.findByRole('table');

      await user.click(screen.getByRole('button', { name: 'Service' }));
      const ec2 = await screen.findByRole('checkbox', { name: /Amazon EC2/ });
      expect(api.filterValueCalls[0]).toEqual({
        dimensionId: 'service',
        filters: {},
        dateRange: defaultRange(),
        granularity: 'daily',
        applyCostScope: false,
        costMetric: 'effective',
        origin: 'explorer:filter-values:service',
      });

      await user.click(ec2);
      await user.click(screen.getByRole('button', { name: 'Apply' }));
      await waitFor(() => {
        expect(api.rowsCalls).toHaveLength(2);
      });
      expect(api.rowsCalls[1]?.filters).toEqual({ service: ['Amazon EC2'] });
      expect(screen.getByText('Service: Amazon EC2')).toBeDefined();
    });

    it('toggling Apply Cost Scope and picking a metric re-query with the new params', async () => {
      const { api, user } = renderExplorer();
      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(1);
      });

      await user.click(screen.getByRole('checkbox', { name: /Apply Cost Scope/ }));
      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(2);
      });
      expect(api.overviewCalls[1]?.applyCostScope).toBe(true);

      await user.click(screen.getByRole('radio', { name: /Billed/ }));
      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(3);
      });
      expect(api.overviewCalls[2]?.costMetric).toBe('billed');
      expect(api.overviewCalls[2]?.applyCostScope).toBe(true);
    });
  });

  describe('sorting', () => {
    it('sort clicks re-query rows with the sort payload and leave the histogram query alone', async () => {
      const { api, user } = renderExplorer();
      await screen.findByRole('table');
      await waitFor(() => {
        expect(api.rowsCalls).toHaveLength(1);
      });

      async function clickAccountHeader(): Promise<void> {
        const table = await screen.findByRole('table');
        await user.click(within(table).getByRole('button', { name: /^Account/ }));
      }

      await clickAccountHeader();
      await waitFor(() => {
        expect(api.rowsCalls).toHaveLength(2);
      });
      expect(api.rowsCalls[1]?.sort).toEqual({ column: 'account_name', direction: 'asc' });

      await clickAccountHeader();
      await waitFor(() => {
        expect(api.rowsCalls).toHaveLength(3);
      });
      expect(api.rowsCalls[2]?.sort).toEqual({ column: 'account_name', direction: 'desc' });

      // Third click removes the sort entirely — the payload drops the key.
      await clickAccountHeader();
      await waitFor(() => {
        expect(api.rowsCalls).toHaveLength(4);
      });
      const unsorted = api.rowsCalls[3];
      expect(unsorted).toBeDefined();
      if (unsorted === undefined) return;
      expect('sort' in unsorted).toBe(false);

      // The overview (histogram) never refetched across all three sorts.
      expect(api.overviewCalls).toHaveLength(1);
    });
  });

  describe('date range', () => {
    it('picking a preset re-queries both slices with the new range and persists it', async () => {
      const { api, user } = renderExplorer();
      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(1);
      });

      await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
      await user.click(screen.getByRole('button', { name: 'Last 90 days' }));

      const expected = { start: daysAgo(92), end: daysAgo(2) };
      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(2);
        expect(api.rowsCalls).toHaveLength(2);
      });
      expect(api.overviewCalls[1]?.dateRange).toEqual(expected);
      expect(api.rowsCalls[1]?.dateRange).toEqual(expected);
      await waitFor(() => {
        expect(api.savedPreferences.at(-1)?.lastUsedDateRange).toEqual(expected);
      });
      expect(api.savedPreferences.at(-1)?.lastUsedGranularity).toBe('daily');
    });
  });

  describe('hourly auto-switch wiring', () => {
    it('a small drag-selected range shows the hourly hint when the hourly tier is not configured', async () => {
      const { api, user } = renderExplorer();
      await screen.findAllByRole('img');

      dragHistogram(5, 75); // bars 0–1 → 2026-03-01..02, 2 days ≤ threshold

      expect(await screen.findByText(/hourly tier isn/)).toBeDefined();
      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(2);
      });
      expect(api.overviewCalls[1]?.dateRange).toEqual({ start: '2026-03-01', end: '2026-03-02' });
      expect(api.overviewCalls[1]?.granularity).toBe('daily');
      expect(screen.getByText('Daily total')).toBeDefined();

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(/hourly tier isn/)).toBeNull();
    });

    it('a small drag-selected range auto-switches to hourly when the tier is configured', async () => {
      const api = new ExplorerMockApi();
      api.getConfig = () => Promise.resolve(HOURLY_CONFIG);
      renderExplorer(api);
      await screen.findAllByRole('img');

      dragHistogram(5, 75);

      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(2);
      });
      expect(api.overviewCalls[1]?.granularity).toBe('hourly');
      expect(api.overviewCalls[1]?.dateRange).toEqual({ start: '2026-03-01', end: '2026-03-02' });
      await waitFor(() => {
        expect(api.rowsCalls.at(-1)?.granularity).toBe('hourly');
      });
      expect(screen.getByText('Hourly total')).toBeDefined();
      expect(screen.queryByText(/hourly tier isn/)).toBeNull();
    });

    it('a drag wider than the threshold stays daily with no hint', async () => {
      const { api } = renderExplorer();
      await screen.findAllByRole('img');

      dragHistogram(5, 250); // bars 0–7 → 2026-03-01..08, 8 days > threshold

      await waitFor(() => {
        expect(api.overviewCalls).toHaveLength(2);
      });
      expect(api.overviewCalls[1]?.dateRange).toEqual({ start: '2026-03-01', end: '2026-03-08' });
      expect(api.overviewCalls[1]?.granularity).toBe('daily');
      expect(screen.queryByText(/hourly tier isn/)).toBeNull();
      expect(screen.getByText('Daily total')).toBeDefined();
    });
  });

  describe('loading and error states', () => {
    it('shows coin loaders and no table while both queries are in flight', async () => {
      class PendingExplorerApi extends MockCostApi {
        override queryExplorerOverview(): Promise<ExplorerOverviewResult> {
          return new Promise(() => undefined);
        }

        override queryExplorerRows(): Promise<ExplorerRowsResult> {
          return new Promise(() => undefined);
        }
      }
      render(
        <CostApiProvider value={new PendingExplorerApi()}>
          <ExplorerView />
        </CostApiProvider>,
      );
      const coins = await screen.findAllByText('$');
      expect(coins.length).toBeGreaterThan(0);
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByText(/line items/)).toBeNull();
    });

    it('surfaces query failures: rows error in the table, overview falling back to the empty histogram', async () => {
      class FailingExplorerApi extends MockCostApi {
        override queryExplorerOverview(): Promise<ExplorerOverviewResult> {
          return Promise.reject(new Error('overview exploded'));
        }

        override queryExplorerRows(): Promise<ExplorerRowsResult> {
          return Promise.reject(new Error('rows exploded'));
        }
      }
      render(
        <CostApiProvider value={new FailingExplorerApi()}>
          <ExplorerView />
        </CostApiProvider>,
      );
      expect(await screen.findByText('rows exploded')).toBeDefined();
      expect(await screen.findByText('No data in the selected range.')).toBeDefined();
      expect(screen.queryByRole('table')).toBeNull();
    });
  });
});
