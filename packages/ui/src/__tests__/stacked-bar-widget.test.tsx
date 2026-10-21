import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { CostFocusDispatchProvider, CostFocusProvider, initialFocusState } from '../hooks/use-cost-focus.js';
import type { CostFocusAction, CostFocusState } from '../hooks/use-cost-focus.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { StackedBarWidget } from '../widgets/stacked-bar-widget.js';
import { costsTitle } from '../lib/dates.js';
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

// 2026-03-03 is missing: the widget fills it with an empty bar.
const CURRENT = daily([
  ['2026-03-01', { platform: 60, data: 40 }],
  ['2026-03-02', { platform: 70, data: 30 }],
  ['2026-03-04', { platform: 50, data: 50 }],
  ['2026-03-05', { platform: 90, data: 10 }],
]);

const PREVIOUS = daily([
  ['2026-02-24', { platform: 50 }],
  ['2026-02-25', { platform: 60 }],
  ['2026-02-26', { platform: 70 }],
  ['2026-02-27', { platform: 80 }],
  ['2026-02-28', { platform: 90 }],
]);

/** Serves the current period, or PREVIOUS for the previous-period range, and
 *  records every query. */
class DailyApi extends MockCostApi {
  readonly calls: DailyCostsParams[] = [];
  current: (p: DailyCostsParams) => Promise<DailyCostsResult> = () => Promise.resolve(CURRENT);
  previous: (p: DailyCostsParams) => Promise<DailyCostsResult> = () => Promise.resolve(PREVIOUS);

  override queryDailyCosts(params?: DailyCostsParams): Promise<DailyCostsResult> {
    if (params === undefined) return Promise.reject(new Error('queryDailyCosts called without params'));
    this.calls.push(params);
    return params.dateRange.start === PREV_RANGE.start ? this.previous(params) : this.current(params);
  }
}

interface RenderOptions {
  readonly spec?: WidgetSpec;
  readonly api?: DailyApi;
  readonly compareEnabled?: boolean;
  readonly granularity?: Granularity;
  readonly dateRange?: DateRange;
  readonly previousDateRange?: DateRange;
  readonly focus?: CostFocusState;
  readonly onDateRangeChange?: (range: DateRange, granularity?: Granularity) => void;
}

const SPEC: WidgetSpec = { id: 'sb', type: 'stackedBar', size: 'large', groupBy: SERVICE };

function renderWidget(opts: RenderOptions = {}) {
  const api = opts.api ?? new DailyApi();
  const onSetFilter = vi.fn<(dim: DimensionId, value: TagValue) => void>();
  const dispatch = vi.fn<(action: CostFocusAction) => void>();
  const user = userEvent.setup();
  const utils = render(
    <PaletteProvider>
      <CostApiProvider value={api}>
        <CostFocusProvider value={opts.focus ?? initialFocusState}>
          <CostFocusDispatchProvider value={dispatch}>
            <StackedBarWidget
              spec={opts.spec ?? SPEC}
              dateRange={opts.dateRange ?? RANGE}
              previousDateRange={opts.previousDateRange ?? PREV_RANGE}
              compareEnabled={opts.compareEnabled ?? false}
              granularity={opts.granularity ?? 'daily'}
              globalFilters={{}}
              dimensions={DIMS}
              onSetFilter={onSetFilter}
              onDateRangeChange={opts.onDateRangeChange}
            />
          </CostFocusDispatchProvider>
        </CostFocusProvider>
      </CostApiProvider>
    </PaletteProvider>,
  );
  return { api, onSetFilter, dispatch, user, ...utils };
}

function columns(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('.group.relative')].filter((el): el is HTMLElement => el instanceof HTMLElement);
}

async function bars(container: HTMLElement, count: number): Promise<HTMLElement[]> {
  await waitFor(() => { expect(columns(container)).toHaveLength(count); });
  return columns(container);
}

/** The stacked segments of a bar, largest first. */
function segments(col: HTMLElement | undefined): HTMLElement[] {
  const stack = col?.firstElementChild;
  if (stack === null || stack === undefined) throw new Error('bar has no stack');
  return [...stack.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
}

function firstSegment(col: HTMLElement | undefined): HTMLElement {
  const seg = segments(col)[0];
  if (seg === undefined) throw new Error('bar has no segments');
  return seg;
}

/** Pin the bars area to `width` px and drag across it. */
function drag(container: HTMLElement, width: number, fromX: number, toX: number): void {
  const area = container.querySelector('.items-end.z-10');
  if (!(area instanceof HTMLElement)) throw new Error('no bars area');
  area.getBoundingClientRect = () => new DOMRect(0, 0, width, 200);
  fireEvent.mouseDown(area, { clientX: fromX, clientY: 50, button: 0 });
  fireEvent.mouseMove(window, { clientX: toX, clientY: 50 });
  fireEvent.mouseUp(window);
}

describe('StackedBarWidget — daily bars', () => {
  it('queries the grouped daily costs and fills missing days with empty bars', async () => {
    const { api, container } = renderWidget();

    const cols = await bars(container, 5);
    expect(screen.getByText('03-03')).toBeDefined();
    // The gap day has no spend, so no segments.
    expect(segments(cols[2])).toHaveLength(0);
    expect(segments(cols[0])).toHaveLength(2);

    expect(api.calls[0]).toMatchObject({ groupBy: SERVICE, dateRange: RANGE, granularity: 'daily', origin: 'widget:stackedBar:service' });
    // Compare is off: no previous-period query, no overlay.
    expect(api.calls.some(c => c.dateRange.start === PREV_RANGE.start)).toBe(false);
    expect(container.querySelector('polyline')).toBeNull();
  });

  it('titles itself with a group-by picker that regroups the bars', async () => {
    const { api, user, container } = renderWidget();
    await bars(container, 5);

    await user.click(screen.getByRole('button', { name: 'Service' }));
    await user.click(await screen.findByRole('button', { name: 'Region' }));

    await waitFor(() => { expect(api.calls.at(-1)?.groupBy).toBe(REGION); });
    expect(api.calls.at(-1)?.origin).toBe('widget:stackedBar:region');
    expect(await screen.findByRole('button', { name: 'Region' })).toBeDefined();
  });

  it('uses the spec title when there is one', async () => {
    const { container } = renderWidget({ spec: { ...SPEC, title: 'Spend by service' } });
    await bars(container, 5);

    expect(screen.getByText('Spend by service')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Service' })).toBeNull();
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

describe('StackedBarWidget — weekly and monthly bars', () => {
  it('shows the current unfinished month as an empty bar when it has no data yet', async () => {
    const api = new DailyApi();
    api.current = () => Promise.resolve(daily([
      ['2026-08-01', { platform: 60, data: 40 }],
      ['2026-09-01', { platform: 70, data: 30 }],
    ]));
    const monthRange: DateRange = { start: asDateString('2026-08-01'), end: asDateString('2026-10-31') };
    const { container } = renderWidget({ api, granularity: 'monthly', dateRange: monthRange });

    const cols = await bars(container, 3);
    expect(segments(cols[0])).toHaveLength(2);
    expect(segments(cols[2])).toHaveLength(0);
    for (const label of ['Aug 2026', 'Sep 2026', 'Oct 2026']) expect(screen.getByText(label)).toBeDefined();
    expect(api.calls[0]).toMatchObject({ dateRange: monthRange, granularity: 'monthly' });
  });

  it('fills missing weeks and labels them by ISO week', async () => {
    const api = new DailyApi();
    api.current = () => Promise.resolve(daily([
      ['2026-09-28', { platform: 60 }],
      ['2026-10-12', { platform: 70 }],
    ]));
    const weekRange: DateRange = { start: asDateString('2026-09-28'), end: asDateString('2026-10-18') };
    const { container } = renderWidget({ api, granularity: 'weekly', dateRange: weekRange });

    const cols = await bars(container, 3);
    expect(segments(cols[1])).toHaveLength(0);
    for (const label of ['W40 2026', 'W41 2026', 'W42 2026']) expect(screen.getByText(label)).toBeDefined();
  });

  it('titles a default chart by its granularity', () => {
    expect(costsTitle('monthly')).toBe('Monthly Costs');
    expect(costsTitle('weekly')).toBe('Weekly Costs');
    expect(costsTitle('daily')).toBe('Daily Costs');
    expect(costsTitle('hourly')).toBe('Hourly Costs');
  });
});

describe('StackedBarWidget — cross-chart focus and filtering', () => {
  it('filters on a segment click and broadcasts segment hovers', async () => {
    const { container, onSetFilter, dispatch } = renderWidget();
    const cols = await bars(container, 5);

    // Day 1: platform $60 stacks above data $40.
    fireEvent.click(firstSegment(cols[0]));
    expect(onSetFilter).toHaveBeenCalledWith(SERVICE, asTagValue('platform'));

    fireEvent.mouseEnter(firstSegment(cols[0]));
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: 'HOVER', entity: 'platform', dimension: SERVICE });
    });
  });

  it('honours an external hover only from a chart grouped the same way', async () => {
    const sameDim = renderWidget({ focus: { ...initialFocusState, hoveredDimension: SERVICE, hoveredEntity: 'data' } });
    let cols = await bars(sameDim.container, 5);
    const [platform, data] = segments(cols[0]);
    expect(platform?.style.opacity).toBe('0.25');
    expect(data?.style.opacity).toBe('1');
    sameDim.unmount();

    const otherDim = renderWidget({ focus: { ...initialFocusState, hoveredDimension: REGION, hoveredEntity: 'data' } });
    cols = await bars(otherDim.container, 5);
    for (const seg of segments(cols[0])) expect(seg.style.opacity).toBe('0.85');
  });
});

describe('StackedBarWidget — previous period', () => {
  it('overlays the previous period’s daily totals when it covers the range', async () => {
    const { api, container } = renderWidget({ compareEnabled: true });
    await bars(container, 5);

    await waitFor(() => { expect(container.querySelector('polyline')).not.toBeNull(); });
    const points = container.querySelector('polyline')?.getAttribute('points')?.split(' ') ?? [];
    expect(points).toHaveLength(5);

    const prev = api.calls.find(c => c.dateRange.start === PREV_RANGE.start);
    expect(prev).toMatchObject({ groupBy: SERVICE, origin: 'widget:stackedBar:service/prev' });
  });

  it('skips the overlay when the previous period has too little data', async () => {
    const api = new DailyApi();
    const pending = deferred<DailyCostsResult>();
    api.previous = () => pending.promise;
    const { container } = renderWidget({ api, compareEnabled: true });
    await bars(container, 5);

    await waitFor(() => { expect(api.calls.some(c => c.dateRange.start === PREV_RANGE.start)).toBe(true); });
    // Two of five days is below the 80% coverage bar.
    await settle(pending, daily([['2026-02-27', { platform: 80 }], ['2026-02-28', { platform: 90 }]]));
    expect(container.querySelector('polyline')).toBeNull();
  });

  it('buckets a long previous period to the bar count', async () => {
    const start = Date.UTC(2025, 0, 1);
    const longDays = (from: number, count: number) => Array.from({ length: count }, (_, i): readonly [string, Breakdown] => [
      new Date(from + i * 86_400_000).toISOString().slice(0, 10),
      { platform: 10 + (i % 5) },
    ]);
    const current = daily(longDays(start, 200));
    const range: DateRange = { start: asDateString('2025-01-01'), end: asDateString(new Date(start + 199 * 86_400_000).toISOString().slice(0, 10)) };
    const prevStart = start - 200 * 86_400_000;
    const prevRange: DateRange = { start: asDateString(new Date(prevStart).toISOString().slice(0, 10)), end: asDateString('2024-12-31') };
    const api = new DailyApi();
    api.current = (p) => Promise.resolve(p.dateRange.start === prevRange.start ? daily(longDays(prevStart, 200)) : current);

    const { container } = renderWidget({ api, compareEnabled: true, dateRange: range, previousDateRange: prevRange });

    // 200 days at most 170 bars: two days per bar.
    await bars(container, 100);
    await waitFor(() => { expect(container.querySelector('polyline')).not.toBeNull(); });
    expect(container.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(100);
  });
});

describe('StackedBarWidget — drag to zoom', () => {
  it('zooms the dashboard to the dragged days', async () => {
    const onDateRangeChange = vi.fn<(range: DateRange, granularity?: Granularity) => void>();
    const { container } = renderWidget({ onDateRangeChange });
    await bars(container, 5);

    // 500px for five bars: 100px each. Bars 2–4 (Mar 2 – Mar 4).
    drag(container, 500, 110, 390);
    expect(onDateRangeChange).toHaveBeenCalledWith({ start: '2026-03-02', end: '2026-03-04' });

    // A drag to the last bar runs to the end of the visible range.
    drag(container, 500, 310, 495);
    expect(onDateRangeChange).toHaveBeenLastCalledWith({ start: '2026-03-04', end: '2026-03-05' });
  });

  it('zooms to an hour window on hourly bars', async () => {
    const onDateRangeChange = vi.fn<(range: DateRange, granularity?: Granularity) => void>();
    const api = new DailyApi();
    api.current = () => Promise.resolve(daily([
      ['2026-03-01 10:00', { platform: 5, data: 1 }],
      ['2026-03-01 11:00', { platform: 6, data: 2 }],
      ['2026-03-01 12:00', { platform: 7, data: 3 }],
    ]));
    const day: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-01') };
    const { container } = renderWidget({ api, granularity: 'hourly', dateRange: day, onDateRangeChange });

    // Hourly data is not padded out to whole days.
    await bars(container, 3);

    drag(container, 300, 10, 190);
    expect(onDateRangeChange).toHaveBeenCalledWith({
      start: '2026-03-01',
      end: '2026-03-01',
      startHour: '2026-03-01 10:00:00',
      endHour: '2026-03-01 11:00:00',
    });

    // Dragging over the last hour runs to the end of the day.
    drag(container, 300, 210, 295);
    expect(onDateRangeChange).toHaveBeenLastCalledWith({
      start: '2026-03-01',
      end: '2026-03-01',
      startHour: '2026-03-01 12:00:00',
      endHour: '2026-03-01 23:00:00',
    });
  });

  it('ignores a drag over hourly bars that carry no hour', async () => {
    const onDateRangeChange = vi.fn<(range: DateRange, granularity?: Granularity) => void>();
    const { container } = renderWidget({ granularity: 'hourly', onDateRangeChange });
    await bars(container, 4);

    drag(container, 400, 10, 390);
    expect(onDateRangeChange).not.toHaveBeenCalled();
  });

  it('is not draggable without a range handler', async () => {
    const { container } = renderWidget();
    await bars(container, 5);

    const area = container.querySelector('.items-end.z-10');
    expect(area?.getAttribute('role')).toBeNull();
  });
});
