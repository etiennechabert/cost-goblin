import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDateString, asDimensionId, asDollars, asTagValue } from '@costgoblin/core/browser';
import type {
  DailyCostsParams,
  DailyCostsResult,
  DateRange,
  Dimension,
  DimensionId,
  Granularity,
  TagValue,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { LineWidget } from '../widgets/line-widget.js';
import { deferred, settle } from './deferred.js';

const SERVICE = asDimensionId('service');
const REGION = asDimensionId('region');

const RANGE: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-05') };
const PREV_RANGE: DateRange = { start: asDateString('2026-02-24'), end: asDateString('2026-02-28') };

const DIMS: readonly Dimension[] = [
  { name: SERVICE, label: 'Service', field: 'service' },
  { name: REGION, label: 'Region', field: 'region' },
];

type Breakdown = Readonly<Record<string, number>>;

function daily(entries: readonly (readonly [string, Breakdown])[]): DailyCostsResult {
  const groups = new Set<string>();
  const days = entries.map(([date, breakdown]) => {
    const priced: Record<string, ReturnType<typeof asDollars>> = {};
    let total = 0;
    for (const [k, v] of Object.entries(breakdown)) {
      groups.add(k);
      priced[k] = asDollars(v);
      total += v;
    }
    return { date: asDateString(date), total: asDollars(total), breakdown: priced };
  });
  return { days, groups: [...groups], totalCost: asDollars(days.reduce((s, d) => s + d.total, 0)) };
}

// Over the period: platform $300, data $150, growth $25 (only on two days).
const CURRENT = daily([
  ['2026-03-01', { platform: 50, data: 30, growth: 10 }],
  ['2026-03-02', { platform: 60, data: 30 }],
  ['2026-03-03', { platform: 70, data: 30, growth: 15 }],
  ['2026-03-04', { platform: 60, data: 30 }],
  ['2026-03-05', { platform: 60, data: 30 }],
]);

// Four of five days — enough coverage — so the last current day has no
// previous-period counterpart.
const PREVIOUS = daily([
  ['2026-02-24', { platform: 40, data: 20 }],
  ['2026-02-25', { platform: 45, data: 20 }],
  ['2026-02-26', { platform: 50, data: 20 }],
  ['2026-02-27', { platform: 55 }],
]);

class DailyApi extends MockCostApi {
  readonly calls: DailyCostsParams[] = [];
  current: () => Promise<DailyCostsResult> = () => Promise.resolve(CURRENT);
  previous: () => Promise<DailyCostsResult> = () => Promise.resolve(PREVIOUS);

  override queryDailyCosts(params?: DailyCostsParams): Promise<DailyCostsResult> {
    if (params === undefined) return Promise.reject(new Error('queryDailyCosts called without params'));
    this.calls.push(params);
    return params.origin?.endsWith('/prev') === true ? this.previous() : this.current();
  }

  previousCalls(): DailyCostsParams[] {
    return this.calls.filter(c => c.origin?.endsWith('/prev') === true);
  }
}

const SPEC: WidgetSpec = { id: 'ln', type: 'line', size: 'large', groupBy: SERVICE, topN: 2 };

interface RenderOptions {
  readonly spec?: WidgetSpec;
  readonly api?: DailyApi;
  readonly compareEnabled?: boolean;
  readonly granularity?: Granularity;
  readonly dateRange?: DateRange;
  readonly previousDateRange?: DateRange;
}

function renderWidget(opts: RenderOptions = {}) {
  const api = opts.api ?? new DailyApi();
  const onSetFilter = vi.fn<(dim: DimensionId, value: TagValue) => void>();
  const user = userEvent.setup();
  const utils = render(
    <PaletteProvider>
      <CostApiProvider value={api}>
        <LineWidget
          spec={opts.spec ?? SPEC}
          dateRange={opts.dateRange ?? RANGE}
          previousDateRange={opts.previousDateRange ?? PREV_RANGE}
          compareEnabled={opts.compareEnabled ?? false}
          granularity={opts.granularity ?? 'daily'}
          globalFilters={{}}
          dimensions={DIMS}
          onSetFilter={onSetFilter}
        />
      </CostApiProvider>
    </PaletteProvider>,
  );
  return { api, onSetFilter, user, ...utils };
}

/** Legend entries, in order. */
function legend(): string[] {
  return screen.getAllByTitle(/Click to filter|Show series/).map(b => b.textContent);
}

function lines(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('path.visx-linepath')];
}

function ghostLines(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('path.visx-linepath[stroke-dasharray]')];
}

describe('LineWidget', () => {
  it('plots the top N series by total spend over the period', async () => {
    const { api, container } = renderWidget();

    await waitFor(() => { expect(lines(container)).toHaveLength(2); });
    expect(legend()).toEqual(['platform', 'data']);
    expect(screen.getByText('Top 2 • Click to filter, dbl-click to hide')).toBeDefined();
    expect(api.calls[0]).toMatchObject({ groupBy: SERVICE, dateRange: RANGE, origin: 'widget:line:service' });
    expect(api.previousCalls()).toHaveLength(0);
    expect(ghostLines(container)).toHaveLength(0);
  });

  it('defaults to the top six series', async () => {
    const { container } = renderWidget({ spec: { id: 'ln', type: 'line', size: 'large', groupBy: SERVICE } });

    // Only three series exist, so all of them show; growth is zero on the
    // days it has no spend.
    await waitFor(() => { expect(lines(container)).toHaveLength(3); });
    expect(legend()).toEqual(['platform', 'data', 'growth']);
    expect(screen.getByText('Top 6 • Click to filter, dbl-click to hide')).toBeDefined();
  });

  it('filters on a legend click', async () => {
    const { user, onSetFilter, container } = renderWidget();
    await waitFor(() => { expect(lines(container)).toHaveLength(2); });

    await user.click(screen.getByRole('button', { name: 'data' }));
    expect(onSetFilter).toHaveBeenCalledWith(SERVICE, asTagValue('data'));
  });

  it('titles itself "<dimension> over time" with a picker that regroups', async () => {
    const { user, api, container } = renderWidget();
    await waitFor(() => { expect(lines(container)).toHaveLength(2); });

    await user.click(screen.getByRole('button', { name: 'Service over time' }));
    await user.click(await screen.findByRole('button', { name: 'Region' }));

    await waitFor(() => { expect(api.calls.at(-1)?.groupBy).toBe(REGION); });
    expect(await screen.findByRole('button', { name: 'Region over time' })).toBeDefined();
  });

  it('uses the spec title when there is one', async () => {
    const { container } = renderWidget({ spec: { ...SPEC, title: 'Service trend' } });
    await waitFor(() => { expect(lines(container)).toHaveLength(2); });

    expect(screen.getByText('Service trend')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Service over time' })).toBeNull();
  });

  it('shows the loader while the query is in flight', () => {
    const api = new DailyApi();
    api.current = () => new Promise<DailyCostsResult>(() => undefined);
    renderWidget({ api });

    expect(screen.getByRole('status')).toBeDefined();
  });

  it('renders nothing, and queries nothing, for a spec of another type', async () => {
    const { container, api } = renderWidget({ spec: { id: 's', type: 'summary', size: 'small' } });
    expect(container.innerHTML).toBe('');
    // Queries start on a zero-delay timer: let it fire before checking.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
    expect(api.calls).toHaveLength(0);
    expect(container.innerHTML).toBe('');
  });
});

describe('LineWidget — weekly and monthly', () => {
  it('labels the x axis with month names in Monthly', async () => {
    const api = new DailyApi();
    api.current = () => Promise.resolve(daily([
      ['2026-08-01', { platform: 50, data: 30 }],
      ['2026-09-01', { platform: 60, data: 30 }],
      ['2026-10-01', { platform: 70, data: 30 }],
    ]));
    const dateRange: DateRange = { start: asDateString('2026-08-01'), end: asDateString('2026-10-31') };
    const { container } = renderWidget({ api, granularity: 'monthly', dateRange });

    await waitFor(() => { expect(lines(container)).toHaveLength(2); });
    for (const label of ['Aug 2026', 'Sep 2026', 'Oct 2026']) expect(screen.getByText(label)).toBeDefined();
  });

  it('labels the x axis with ISO weeks in Weekly', async () => {
    const api = new DailyApi();
    api.current = () => Promise.resolve(daily([
      ['2026-10-05', { platform: 50 }],
      ['2026-10-12', { platform: 60 }],
      ['2026-10-19', { platform: 70 }],
    ]));
    const dateRange: DateRange = { start: asDateString('2026-10-05'), end: asDateString('2026-10-25') };
    const { container } = renderWidget({ api, granularity: 'weekly', dateRange });

    await waitFor(() => { expect(lines(container)).toHaveLength(1); });
    for (const label of ['W41 2026', 'W42 2026', 'W43 2026']) expect(screen.getByText(label)).toBeDefined();
  });
});

describe('LineWidget — previous period', () => {
  it('counts a monthly previous result with one bucket per month as sufficient coverage', async () => {
    const months = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];
    const previousMonths = ['2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'];
    const api = new DailyApi();
    api.current = () => Promise.resolve(daily(months.map(m => [m, { platform: 50, data: 30 }] as const)));
    api.previous = () => Promise.resolve(daily(previousMonths.map(m => [m, { platform: 40, data: 20 }] as const)));
    const { container } = renderWidget({
      api,
      compareEnabled: true,
      granularity: 'monthly',
      dateRange: { start: asDateString('2026-03-01'), end: asDateString('2026-10-31') },
      previousDateRange: { start: asDateString('2025-07-01'), end: asDateString('2026-02-28') },
    });

    // Eight months of data is not "8 of 242 days": the overlay draws.
    await waitFor(() => { expect(ghostLines(container)).toHaveLength(2); });
  });

  it('overlays a ghost line per series, aligned day by day', async () => {
    const { api, container } = renderWidget({ compareEnabled: true });

    await waitFor(() => { expect(ghostLines(container)).toHaveLength(2); });
    expect(lines(container)).toHaveLength(4);
    expect(api.previousCalls()[0]).toMatchObject({ groupBy: SERVICE, origin: 'widget:line:service/prev' });
  });

  it('skips the overlay when the previous period has too little data', async () => {
    const api = new DailyApi();
    const pending = deferred<DailyCostsResult>();
    api.previous = () => pending.promise;
    const { container } = renderWidget({ api, compareEnabled: true });

    await waitFor(() => { expect(api.previousCalls()).toHaveLength(1); });
    await waitFor(() => { expect(lines(container)).toHaveLength(2); });
    // One of five days is below the 80% coverage bar.
    await settle(pending, daily([['2026-02-27', { platform: 55 }]]));
    expect(ghostLines(container)).toHaveLength(0);
  });

  it('draws no ghost lines when the current period has no series', async () => {
    const api = new DailyApi();
    api.current = () => Promise.resolve(daily([['2026-03-01', {}], ['2026-03-02', {}]]));
    const pending = deferred<DailyCostsResult>();
    api.previous = () => pending.promise;
    const { container } = renderWidget({ api, compareEnabled: true });

    await waitFor(() => { expect(api.previousCalls()).toHaveLength(1); });
    await waitFor(() => { expect(container.querySelector('rect[fill="transparent"]')).not.toBeNull(); });
    // The previous period has data, but there is no current series to match.
    await settle(pending, PREVIOUS);
    expect(lines(container)).toHaveLength(0);
  });
});
