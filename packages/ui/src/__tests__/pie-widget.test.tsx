import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { asDateString, asDimensionId, asTagValue } from '@costgoblin/core/browser';
import type { DateRange, Dimension, DimensionId, TagValue, WidgetSpec } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { CostFocusDispatchProvider, CostFocusProvider, initialFocusState } from '../hooks/use-cost-focus.js';
import type { CostFocusAction, CostFocusState } from '../hooks/use-cost-focus.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { PieWidget } from '../widgets/pie-widget.js';
import { takeMemoRenders } from './memo-renders.js';

vi.mock('react', async (importOriginal) =>
  (await import('./memo-renders.js')).withMemoSpy(await importOriginal<typeof import('react')>()));

beforeEach(() => {
  takeMemoRenders();
});

const SERVICE = asDimensionId('service');
const REGION = asDimensionId('region');

const RANGE: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') };
const PREV_RANGE: DateRange = { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') };

const DIMS: readonly Dimension[] = [
  { name: SERVICE, label: 'Service', field: 'service' },
  { name: REGION, label: 'Region', field: 'region' },
];

const SPEC: WidgetSpec = { id: 'pie', type: 'pie', size: 'medium', groupBy: SERVICE };

// MockCostApi answers every cost query with the same five entities.
const ENTITIES = ['platform', 'data', 'growth', 'infra', 'ml'];

function renderWidget() {
  const api = new MockCostApi();
  const onSetFilter = vi.fn<(dim: DimensionId, value: TagValue) => void>();
  const dispatch = vi.fn<(action: CostFocusAction) => void>();
  const tree = (focus: CostFocusState): React.ReactElement => (
    <PaletteProvider>
      <CostApiProvider value={api}>
        <CostFocusProvider value={focus}>
          <CostFocusDispatchProvider value={dispatch}>
            <PieWidget
              spec={SPEC}
              dateRange={RANGE}
              previousDateRange={PREV_RANGE}
              compareEnabled={false}
              granularity="daily"
              globalFilters={{}}
              dimensions={DIMS}
              onSetFilter={onSetFilter}
            />
          </CostFocusDispatchProvider>
        </CostFocusProvider>
      </CostApiProvider>
    </PaletteProvider>
  );
  const utils = render(tree(initialFocusState));
  /** The same widget under another cross-chart focus: what a HOVER dispatched
   *  by any chart on the dashboard does to it. */
  const refocus = (focus: CostFocusState): void => { utils.rerender(tree(focus)); };
  return { onSetFilter, dispatch, refocus, ...utils };
}

function slicePaths(container: HTMLElement): SVGPathElement[] {
  return [...container.querySelectorAll<SVGPathElement>('svg g[style] > path')];
}

function lit(container: HTMLElement): boolean[] {
  return slicePaths(container).map(path => path.getAttribute('stroke') === '#ffffff');
}

describe('PieWidget — cross-chart focus', () => {
  // Every HOVER a chart dispatches renders this widget, which reads the focus
  // and hands the pie new handler closures and a new title element. The
  // default dashboard has three pies under a histogram that dispatches one on
  // most pointer moves.
  it('renders no slice or legend row on a hover in a chart grouped another way, and only the two the focus moves between on one grouped the same way', async () => {
    const { container, refocus } = renderWidget();
    await waitFor(() => { expect(slicePaths(container)).toHaveLength(ENTITIES.length); });
    const takeRenders = (): Readonly<Record<string, number>> => takeMemoRenders('PieSliceMark', 'PieLegendRow');
    // Forget the renders that drew the pie.
    takeRenders();

    refocus({ ...initialFocusState, hoveredDimension: REGION, hoveredEntity: 'eu-west-1' });
    refocus({ ...initialFocusState, hoveredDimension: REGION, hoveredEntity: 'us-east-1' });
    expect(lit(container)).toEqual([false, false, false, false, false]);
    expect(takeRenders()).toEqual({ PieSliceMark: 0, PieLegendRow: 0 });

    // A first focus dims every other slice: all five render.
    refocus({ ...initialFocusState, hoveredDimension: SERVICE, hoveredEntity: 'data' });
    expect(lit(container)).toEqual([false, true, false, false, false]);
    expect(takeRenders()).toEqual({ PieSliceMark: 5, PieLegendRow: 5 });

    refocus({ ...initialFocusState, hoveredDimension: SERVICE, hoveredEntity: 'infra' });
    expect(lit(container)).toEqual([false, false, false, true, false]);
    expect(takeRenders()).toEqual({ PieSliceMark: 2, PieLegendRow: 2 });
  });

  it('still filters and reports its hovers after the dashboard focus changed', async () => {
    const { container, refocus, onSetFilter, dispatch } = renderWidget();
    await waitFor(() => { expect(slicePaths(container)).toHaveLength(ENTITIES.length); });

    refocus({ ...initialFocusState, hoveredDimension: REGION, hoveredEntity: 'eu-west-1' });

    fireEvent.click(screen.getByRole('button', { name: /growth/ }));
    expect(onSetFilter.mock.calls).toEqual([[SERVICE, asTagValue('growth')]]);

    fireEvent.mouseEnter(screen.getByRole('button', { name: /infra/ }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'HOVER', entity: 'infra', dimension: SERVICE });
  });
});
