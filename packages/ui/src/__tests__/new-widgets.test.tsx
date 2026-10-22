import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { asDateString, asDimensionId, asDollars } from '@costgoblin/core/browser';
import type { DailyCostsResult, DateRange, Granularity, ViewSpec } from '@costgoblin/core/browser';
import { PaletteProvider } from '../hooks/use-palette.js';
import { HeatmapWidget } from '../widgets/heatmap-widget.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CustomView } from '../views/custom-view.js';
import { setReducedMotion } from './setup.js';

const VIEW: ViewSpec = {
  id: 'new-widgets',
  name: 'New Widgets',
  rows: [
    {
      widgets: [
        { id: 'wf', type: 'waterfall', size: 'large', groupBy: asDimensionId('service') },
        { id: 'pv', type: 'priceVolume', size: 'large', groupBy: asDimensionId('service') },
      ],
    },
    {
      widgets: [
        { id: 'bd', type: 'burndown', size: 'large', budget: 100_000 },
        { id: 'pa', type: 'pareto', size: 'large', groupBy: asDimensionId('service') },
      ],
    },
  ],
};

afterEach(cleanup);

// Hold the widgets' coin-rain loaders still: animated, each sets state every
// frame, which keeps restarting the transition useQuery commits a result in,
// and on a loaded CI runner the result only lands after ~5 s, the whole test
// budget. setup.ts restores the preference after each test.
beforeEach(() => { setReducedMotion(true); });

function renderView(spec: ViewSpec = VIEW) {
  return render(
    <CostApiProvider value={new MockCostApi()}>
      <CustomView spec={spec} headerSubtitle="hello" />
    </CostApiProvider>,
  );
}

describe('new analysis widgets', () => {
  it('renders all four widget types without crashing', () => {
    expect(() => renderView()).not.toThrow();
    expect(screen.getByText('New Widgets')).toBeDefined();
  });

  it('renders the burndown widget once data loads', async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByText(/Cumulative spend/)).toBeDefined();
    });
    // The header shows before the container is measured; the chart body
    // (here its hover area) mounts only after the mocked ResizeObserver
    // reports a width. Without this wait, whether the body ever rendered
    // depended on how fast the runner was.
    await waitFor(() => {
      expect(screen.getByTestId('burndown-hit-area')).toBeDefined();
    });
  });

  it('shows the price-volume empty state when there is no period-over-period change', async () => {
    // MockCostApi returns identical current/previous aggregates, so every
    // group's delta is zero and the decomposition is empty.
    renderView();
    await waitFor(() => {
      expect(screen.getByText(/No period-over-period change to decompose/)).toBeDefined();
    });
  });
});

class PeriodApi extends MockCostApi {
  constructor(private readonly keys: readonly string[]) { super(); }

  override queryDailyCosts(): Promise<DailyCostsResult> {
    const days = this.keys.map(date => ({
      date: asDateString(date),
      total: asDollars(100),
      breakdown: { platform: asDollars(60), data: asDollars(40) },
    }));
    return Promise.resolve({ days, groups: ['platform', 'data'], totalCost: asDollars(100 * days.length) });
  }
}

function renderHeatmap(granularity: Granularity, keys: readonly string[], dateRange: DateRange) {
  const service = asDimensionId('service');
  return render(
    <PaletteProvider>
      <CostApiProvider value={new PeriodApi(keys)}>
        <HeatmapWidget
          spec={{ id: 'hm', type: 'heatmap', size: 'large', groupBy: service }}
          dateRange={dateRange}
          previousDateRange={dateRange}
          compareEnabled={false}
          granularity={granularity}
          globalFilters={{}}
          dimensions={[{ name: service, label: 'Service', field: 'service' }]}
          onSetFilter={() => undefined}
        />
      </CostApiProvider>
    </PaletteProvider>,
  );
}

describe('heatmap widget periods', () => {
  it('titles itself "× Month" and labels its columns by month in Monthly', async () => {
    renderHeatmap('monthly', ['2026-08-01', '2026-09-01', '2026-10-01'], { start: asDateString('2026-08-01'), end: asDateString('2026-10-31') });

    expect(await screen.findByRole('button', { name: 'Service × Month' })).toBeDefined();
    for (const label of ['Aug 2026', 'Sep 2026', 'Oct 2026']) expect(await screen.findByText(label)).toBeDefined();
  });

  it('titles itself "× Week" and labels its columns by ISO week in Weekly', async () => {
    renderHeatmap('weekly', ['2026-10-05', '2026-10-12'], { start: asDateString('2026-10-05'), end: asDateString('2026-10-18') });

    expect(await screen.findByRole('button', { name: 'Service × Week' })).toBeDefined();
    for (const label of ['W41 2026', 'W42 2026']) expect(await screen.findByText(label)).toBeDefined();
  });

  it('keeps "× Day" and MM-DD labels in Daily', async () => {
    renderHeatmap('daily', ['2026-10-05', '2026-10-06'], { start: asDateString('2026-10-05'), end: asDateString('2026-10-06') });

    expect(await screen.findByRole('button', { name: 'Service × Day' })).toBeDefined();
    expect(await screen.findByText('10-05')).toBeDefined();
  });

  it('gives the current month a column even before it has any data', async () => {
    renderHeatmap('monthly', ['2026-08-01', '2026-09-01'], { start: asDateString('2026-08-01'), end: asDateString('2026-10-31') });

    for (const label of ['Aug 2026', 'Sep 2026', 'Oct 2026']) expect(await screen.findByText(label)).toBeDefined();
  });

  it('does not add columns for missing days in Daily', async () => {
    renderHeatmap('daily', ['2026-10-05', '2026-10-07'], { start: asDateString('2026-10-05'), end: asDateString('2026-10-07') });

    expect(await screen.findByText('10-07')).toBeDefined();
    expect(screen.queryByText('10-06')).toBeNull();
  });
});
