import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CostGoblinConfig,
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  Dimension,
  ExplorerPreferencesUpdate,
  ViewSpec,
} from '@costgoblin/core/browser';
import { asBucketPath, asDateString, asDimensionId, asDollars, asProviderName } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CustomView } from '../views/custom-view.js';
import { setReducedMotion } from './setup.js';

// The clock is pinned (see beforeEach), so the default "last 30 days" range is
// 2026-02-11 → 2026-03-13 (lag 2 days).
const DEFAULT_START = '2026-02-11';
const DEFAULT_END = '2026-03-13';

const HOURLY_CONFIG: CostGoblinConfig = {
  providers: [
    {
      name: asProviderName('aws-main'),
      type: 'aws',
      credentialsProfile: 'default',
      sync: {
        daily: { bucket: asBucketPath('cur/daily'), retentionDays: 90 },
        hourly: { bucket: asBucketPath('cur/hourly'), retentionDays: 30 },
        intervalMinutes: 60,
      },
    },
  ],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

function view(widgets: ViewSpec['rows'][number]['widgets']): ViewSpec {
  return { id: 'test-view', name: 'Test view', rows: [{ widgets }] };
}

const STACKED = view([{ id: 'bars', type: 'stackedBar', size: 'full', groupBy: asDimensionId('service') }]);
const SUMMARY = view([{ id: 'total', type: 'summary', size: 'small', metric: 'total' }]);

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

class ViewApi extends MockCostApi {
  readonly dailyCalls: DailyCostsParams[] = [];
  readonly costCalls: CostQueryParams[] = [];
  readonly filterValueCalls: { dimensionId: string; filters: Record<string, readonly string[]>; origin: string | undefined }[] = [];

  /** One bar per day of the requested range, or six hourly bars on its last day. */
  override queryDailyCosts(params?: DailyCostsParams): Promise<DailyCostsResult> {
    if (params !== undefined) this.dailyCalls.push(params);
    const end = String(params?.dateRange.end ?? DEFAULT_END);
    const dates = params?.granularity === 'hourly'
      ? Array.from({ length: 6 }, (_, i) => `${end} ${String(10 + i).padStart(2, '0')}:00`)
      : datesBetween(String(params?.dateRange.start ?? DEFAULT_START), end);
    return Promise.resolve({
      days: dates.map((date, i) => ({
        date: asDateString(date),
        total: asDollars(100 + i),
        breakdown: { 'Amazon EC2': asDollars(60 + i), 'Amazon S3': asDollars(40) },
      })),
      groups: ['Amazon EC2', 'Amazon S3'],
      totalCost: asDollars(100 * dates.length),
    });
  }

  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    if (params !== undefined) this.costCalls.push(params);
    return super.queryCosts();
  }

  override getFilterValues(
    dimensionId?: string,
    filters?: Record<string, readonly string[]>,
    _dateRange?: { start: string; end: string },
    _opts?: { bypassCostScope?: boolean },
    origin?: string,
  ): Promise<{ value: string; label: string; count: number }[]> {
    this.filterValueCalls.push({ dimensionId: dimensionId ?? '', filters: filters ?? {}, origin });
    const values: Record<string, { value: string; label: string; count: number }[]> = {
      service: [
        { value: 'Amazon EC2', label: 'Amazon EC2', count: 18_000 },
        { value: 'Amazon RDS', label: 'Amazon RDS', count: 9_500 },
      ],
      region: [{ value: 'eu-central-1', label: 'eu-central-1', count: 20_000 }],
    };
    return Promise.resolve(values[dimensionId ?? ''] ?? []);
  }
}

function renderView(spec: ViewSpec, api: ViewApi = new ViewApi()) {
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <CustomView spec={spec} />
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

/** The stacked bar widget's drag surface; jsdom has no layout, so pin a rect. */
async function dragBars(fromX: number, toX: number): Promise<void> {
  await waitFor(() => { expect(document.querySelector('div[role="button"]')).not.toBeNull(); });
  const bars = document.querySelector('div[role="button"]');
  if (bars === null) throw new Error('bars not rendered');
  bars.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
  fireEvent.mouseDown(bars, { clientX: fromX, clientY: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: toX, clientY: 100 });
  fireEvent.mouseUp(window);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
  // Hold the widgets' coin-rain loaders still. Animated, each sets state on
  // every frame, and those urgent updates keep restarting the transition
  // useQuery commits a widget's result in; on a loaded CI runner the chart
  // then only lands once React expires the transition (~5 s), the whole
  // findBy budget. setup.ts restores the preference after each test.
  setReducedMotion(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CustomView — drag-to-zoom from a widget', () => {
  it('zooms to a short range and hints at the hourly tier when it is not configured', async () => {
    const { api, user } = renderView(STACKED);
    await waitFor(() => { expect(api.dailyCalls.length).toBeGreaterThan(0); });

    await dragBars(0, 29); // 31 daily bars over 300px → bars 0–2
    expect(await screen.findByText(/hourly tier isn/)).toBeDefined();
    await waitFor(() => {
      expect(api.dailyCalls.at(-1)?.dateRange).toEqual({ start: '2026-02-11', end: '2026-02-13' });
    });
    expect(api.dailyCalls.at(-1)?.granularity).toBe('daily');
    expect(screen.getByRole('button', { name: /2026-02-11 → 2026-02-13/ })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/hourly tier isn/)).toBeNull();
  });

  it('zooms to a range longer than a week without any hint', async () => {
    const { api } = renderView(STACKED);
    await waitFor(() => { expect(api.dailyCalls.length).toBeGreaterThan(0); });

    await dragBars(0, 135); // bars 0–13 → two weeks
    await waitFor(() => {
      expect(api.dailyCalls.at(-1)?.dateRange).toEqual({ start: '2026-02-11', end: '2026-02-24' });
    });
    expect(screen.queryByText(/hourly tier isn/)).toBeNull();
  });

  it('switches to hourly for a short range when the hourly tier is configured', async () => {
    const api = new ViewApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue(HOURLY_CONFIG);
    renderView(STACKED, api);
    // The Hourly toggle enables once the config says the tier exists.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Hourly' })).toHaveProperty('disabled', false); });

    await dragBars(0, 29);
    await waitFor(() => { expect(api.dailyCalls.at(-1)?.granularity).toBe('hourly'); });
    expect(api.dailyCalls.at(-1)?.dateRange).toEqual({ start: '2026-02-11', end: '2026-02-13' });
    expect(screen.queryByText(/hourly tier isn/)).toBeNull();
  });

  it('compares an hour-level zoom against the same number of hours just before it', async () => {
    const api = new ViewApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue(HOURLY_CONFIG);
    const { user } = renderView(STACKED, api);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Hourly' })).toHaveProperty('disabled', false); });

    await user.click(screen.getByRole('button', { name: 'Hourly' }));
    await user.click(screen.getByRole('button', { name: `${DEFAULT_START} → ${DEFAULT_END}` }));
    await user.click(await screen.findByRole('checkbox', { name: 'Compare to previous period' }));
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(api.dailyCalls.at(-1)?.granularity).toBe('hourly'); });

    await dragBars(5, 95); // six hourly bars → 10:00 and 11:00 on the range's last day
    await waitFor(() => {
      expect(api.dailyCalls.filter(c => c.origin === 'widget:stackedBar:service/prev').at(-1)?.dateRange).toEqual({
        start: DEFAULT_END,
        end: DEFAULT_END,
        startHour: `${DEFAULT_END} 08:00:00`,
        endHour: `${DEFAULT_END} 09:00:00`,
      });
    });
    expect(screen.queryByText(/hourly tier isn/)).toBeNull();
  });
});

describe('CustomView — filtering from widgets', () => {
  it('filters the whole view by a pie legend entry', async () => {
    const { api, user } = renderView(view([{ id: 'pie', type: 'pie', size: 'medium', groupBy: asDimensionId('service') }]));

    await user.click(await screen.findByRole('button', { name: /^platform/ }));

    expect(await screen.findByRole('button', { name: 'Service: platform' })).toBeDefined();
    await waitFor(() => { expect(api.costCalls.at(-1)?.filters).toEqual({ service: ['platform'] }); });
  });

  it('filters the whole view by a clicked bubble', async () => {
    const { container } = renderView(view([{ id: 'movers', type: 'bubble', size: 'large', groupBy: asDimensionId('service') }]));

    await waitFor(() => { expect(container.querySelectorAll('circle').length).toBeGreaterThan(0); });
    const bubble = container.querySelector('circle');
    if (bubble === null) throw new Error('no bubble rendered');
    fireEvent.click(bubble);

    expect(await screen.findByRole('button', { name: /^Service: (platform|data|growth|infra|ml)$/ })).toBeDefined();
  });
});

describe('CustomView — group-bys on a dimension that is not enabled', () => {
  // The mock's enabled dimensions, in order: provider, account, service,
  // region, resource_id, then the team/env/product tags.
  const STACK = 'tag_aws_cloudformation_stack_name';
  const PIES = view([
    { id: 'stack', type: 'pie', size: 'medium', groupBy: asDimensionId(STACK) },
    { id: 'svc', type: 'pie', size: 'medium', groupBy: asDimensionId('service') },
    { id: 'reg', type: 'pie', size: 'medium', groupBy: asDimensionId('region') },
  ]);

  it('groups by the first enabled dimension the view does not show, and never queries the other', async () => {
    const { api } = renderView(PIES);

    await waitFor(() => {
      expect(new Set(api.costCalls.map(c => String(c.groupBy)))).toEqual(new Set(['provider', 'service', 'region']));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-widget-id="stack"] button')?.textContent).toBe('Provider');
    }, { timeout: 5000 });
    expect(screen.queryByText(STACK)).toBeNull();
  });

  it('shows the dashboard as configured when the dimensions fail to load', async () => {
    class NoDimensionsApi extends ViewApi {
      override getDimensions(): Promise<Dimension[]> {
        return Promise.reject(new Error('dimensions.yaml is broken'));
      }
    }
    const { api } = renderView(PIES, new NoDimensionsApi());

    await waitFor(() => {
      expect(new Set(api.costCalls.map(c => String(c.groupBy)))).toEqual(new Set([STACK, 'service', 'region']));
    });
  });
});

describe('CustomView — filter bar', () => {
  it('orders chips by dimension concept and pre-applies dimension defaults', async () => {
    const api = new ViewApi();
    const dims: Dimension[] = [
      { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
      { tagName: 'cost_center', label: 'Cost center' },
      { tagName: 'bu', label: 'Business unit', concept: 'unit' },
      { tagName: 'team', label: 'Team', concept: 'owner' },
      { tagName: 'product', label: 'Product', concept: 'product' },
      { tagName: 'env', label: 'Environment', concept: 'environment', defaultFilterValues: ['prod'] },
    ];
    vi.spyOn(api, 'getDimensions').mockResolvedValue(dims);
    renderView(SUMMARY, api);

    await screen.findByRole('button', { name: 'Environment: prod' });
    const chips = screen.getAllByRole('button')
      .map(b => b.textContent)
      .filter(t => /^(Environment|Product|Team|Business unit|Account|Cost center)/.test(t));
    expect(chips).toEqual(['Environment: prod', 'Product', 'Team', 'Business unit', 'Account', 'Cost center']);
    await waitFor(() => { expect(api.costCalls.at(-1)?.filters).toEqual({ tag_env: ['prod'] }); });
  });

  it('serves dropdowns from the prefetch, and queries live once another filter narrows them', async () => {
    const { api, user } = renderView(SUMMARY);
    await waitFor(() => {
      expect(api.filterValueCalls.filter(c => c.origin?.startsWith('filter-bar:prefetch:') === true)).toHaveLength(8);
    });

    await user.click(screen.getByRole('button', { name: 'Region' }));
    expect(await screen.findByRole('checkbox', { name: 'eu-central-1' })).toHaveProperty('checked', true);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('button', { name: 'Region: eu-central-1' });
    // Opening an unfiltered view's dropdown never queried live.
    expect(api.filterValueCalls.filter(c => c.origin === 'filter-bar:region')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Service' }));
    expect(await screen.findByRole('checkbox', { name: 'Amazon RDS' })).toBeDefined();
    expect(api.filterValueCalls.filter(c => c.origin === 'filter-bar:service')).toEqual([
      { dimensionId: 'service', filters: { region: ['eu-central-1'] }, origin: 'filter-bar:service' },
    ]);
  });

  it('queries live when the prefetch for a dimension failed', async () => {
    class FailingPrefetchApi extends ViewApi {
      override getFilterValues(
        dimensionId?: string,
        filters?: Record<string, readonly string[]>,
        dateRange?: { start: string; end: string },
        opts?: { bypassCostScope?: boolean },
        origin?: string,
      ): Promise<{ value: string; label: string; count: number }[]> {
        if (origin?.startsWith('filter-bar:prefetch:') === true) {
          this.filterValueCalls.push({ dimensionId: dimensionId ?? '', filters: filters ?? {}, origin });
          return Promise.reject(new Error('prefetch failed'));
        }
        return super.getFilterValues(dimensionId, filters, dateRange, opts, origin);
      }
    }
    const api = new FailingPrefetchApi();
    const { user } = renderView(SUMMARY, api);
    await waitFor(() => {
      expect(api.filterValueCalls.filter(c => c.origin?.startsWith('filter-bar:prefetch:') === true)).toHaveLength(8);
    });

    await user.click(screen.getByRole('button', { name: 'Service' }));
    expect(await screen.findByRole('checkbox', { name: 'Amazon EC2' })).toBeDefined();
    expect(api.filterValueCalls.filter(c => c.origin === 'filter-bar:service')).toEqual([
      { dimensionId: 'service', filters: {}, origin: 'filter-bar:service' },
    ]);
  });

  it('keeps the prefetched values across a granularity round-trip, refetching for a new period', async () => {
    const api = new ViewApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue(HOURLY_CONFIG);
    const { user } = renderView(SUMMARY, api);
    const prefetches = (): number => api.filterValueCalls.filter(c => c.origin?.startsWith('filter-bar:prefetch:') === true).length;
    await waitFor(() => { expect(prefetches()).toBe(8); });
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Hourly' })).toHaveProperty('disabled', false); });

    await user.click(screen.getByRole('button', { name: 'Hourly' }));
    await user.click(screen.getByRole('button', { name: 'Daily' }));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(prefetches()).toBe(8);

    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    await user.click(await screen.findByRole('button', { name: 'Last 90 days' }));
    await waitFor(() => { expect(prefetches()).toBe(16); });
  });

  it('persists the session after a change and swallows a failed write', async () => {
    class ReadOnlyApi extends ViewApi {
      override saveExplorerPreferences(prefs: ExplorerPreferencesUpdate): Promise<void> {
        void super.saveExplorerPreferences(prefs);
        return Promise.reject(new Error('read-only preferences'));
      }
    }
    const api = new ReadOnlyApi();
    const { user } = renderView(SUMMARY, api);
    await screen.findByText('Test view');

    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    await user.click(await screen.findByRole('button', { name: 'Last 90 days' }));

    await waitFor(() => {
      expect(api.savedExplorerPreferences.at(-1)).toEqual({
        lastUsedDateRange: { start: '2025-12-13', end: DEFAULT_END },
        lastUsedGranularity: 'daily',
        compareEnabled: false,
      });
    }, { timeout: 3000 });
    expect(screen.queryByText('read-only preferences')).toBeNull();
    expect(screen.getByText('Test view')).toBeDefined();
  });
});
