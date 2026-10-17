import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDateString, asDimensionId, asDollars, asEntityRef, asTagValue } from '@costgoblin/core/browser';
import type {
  CostQueryParams,
  CostResult,
  DateRange,
  Dimension,
  DimensionId,
  TagValue,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { CostFocusDispatchProvider, CostFocusProvider, initialFocusState } from '../hooks/use-cost-focus.js';
import type { CostFocusAction, CostFocusState } from '../hooks/use-cost-focus.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { TopNBarWidget } from '../widgets/top-n-bar-widget.js';

const ACCOUNT = asDimensionId('account');
const REGION = asDimensionId('region');

const RANGE: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-10') };
const PREV_RANGE: DateRange = { start: asDateString('2026-02-19'), end: asDateString('2026-02-28') };

const DIMS: readonly Dimension[] = [
  { name: ACCOUNT, label: 'Account', field: 'account_id' },
  { name: REGION, label: 'Region', field: 'region' },
];

function costs(rows: readonly (readonly [string, number])[], range: DateRange): CostResult {
  return {
    rows: rows.map(([entity, cost]) => ({ entity: asEntityRef(entity), totalCost: asDollars(cost), serviceCosts: {} })),
    totalCost: asDollars(rows.reduce((s, [, c]) => s + c, 0)),
    topServices: [],
    dateRange: range,
  };
}

const CURRENT = costs([['prod', 600], ['staging', 300], ['dev', 100]], RANGE);
const PREVIOUS = costs([['prod', 500], ['staging', 400]], PREV_RANGE);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Resolve a pending query result and let React commit what it renders. */
async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T): Promise<void> {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
  });
}

class CostsApi extends MockCostApi {
  readonly calls: CostQueryParams[] = [];
  current: () => Promise<CostResult> = () => Promise.resolve(CURRENT);
  previous: () => Promise<CostResult> = () => Promise.resolve(PREVIOUS);

  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    if (params === undefined) return Promise.reject(new Error('queryCosts called without params'));
    this.calls.push(params);
    return params.dateRange.start === PREV_RANGE.start ? this.previous() : this.current();
  }

  previousCalls(): CostQueryParams[] {
    return this.calls.filter(c => c.dateRange.start === PREV_RANGE.start);
  }
}

const SPEC: WidgetSpec = { id: 'tn', type: 'topNBar', size: 'medium', groupBy: ACCOUNT };

interface RenderOptions {
  readonly spec?: WidgetSpec;
  readonly api?: CostsApi;
  readonly compareEnabled?: boolean;
  readonly focus?: CostFocusState;
}

function renderWidget(opts: RenderOptions = {}) {
  const api = opts.api ?? new CostsApi();
  const onSetFilter = vi.fn<(dim: DimensionId, value: TagValue) => void>();
  const dispatch = vi.fn<(action: CostFocusAction) => void>();
  const user = userEvent.setup();
  const utils = render(
    <PaletteProvider>
      <CostApiProvider value={api}>
        <CostFocusProvider value={opts.focus ?? initialFocusState}>
          <CostFocusDispatchProvider value={dispatch}>
            <TopNBarWidget
              spec={opts.spec ?? SPEC}
              dateRange={RANGE}
              previousDateRange={PREV_RANGE}
              compareEnabled={opts.compareEnabled ?? false}
              granularity="daily"
              globalFilters={{}}
              dimensions={DIMS}
              onSetFilter={onSetFilter}
            />
          </CostFocusDispatchProvider>
        </CostFocusProvider>
      </CostApiProvider>
    </PaletteProvider>,
  );
  return { api, onSetFilter, dispatch, user, ...utils };
}

/** Rows as their "name — cost" tooltips, in rank order. */
async function ranked(): Promise<(string | null)[]> {
  const rows = await screen.findAllByRole('listitem');
  return rows.map(r => r.getAttribute('title'));
}

describe('TopNBarWidget', () => {
  it('ranks entities by cost with their share of the total', async () => {
    const { api } = renderWidget();

    expect(await ranked()).toEqual(['prod — $600.00', 'staging — $300.00', 'dev — $100.00']);
    expect(within(screen.getByTitle('prod — $600.00')).getByText('(60.0%)')).toBeDefined();
    expect(screen.getByText('Click to filter')).toBeDefined();
    expect(api.calls[0]).toMatchObject({ groupBy: ACCOUNT, dateRange: RANGE, origin: 'widget:topNBar:account' });
    expect(api.previousCalls()).toHaveLength(0);
  });

  it('keeps the spec’s top N', async () => {
    renderWidget({ spec: { ...SPEC, topN: 2 } });
    expect(await ranked()).toEqual(['prod — $600.00', 'staging — $300.00']);
  });

  it('reports a 0% share when the whole period cost nothing', async () => {
    const api = new CostsApi();
    api.current = () => Promise.resolve(costs([['prod', 0], ['dev', 0]], RANGE));
    renderWidget({ api });

    await ranked();
    expect(screen.getAllByText('(0.0%)')).toHaveLength(2);
  });

  it('filters on click and broadcasts hovers', async () => {
    const { user, onSetFilter, dispatch } = renderWidget();
    await ranked();

    await user.click(screen.getByRole('button', { name: /^staging/ }));
    expect(onSetFilter).toHaveBeenCalledWith(ACCOUNT, asTagValue('staging'));

    fireEvent.mouseEnter(screen.getByTitle('dev — $100.00'));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'HOVER', entity: 'dev', dimension: ACCOUNT });
  });

  it('highlights an external hover only from a chart grouped the same way', async () => {
    const same = renderWidget({ focus: { ...initialFocusState, hoveredDimension: ACCOUNT, hoveredEntity: 'staging' } });
    await ranked();
    expect(screen.getByTitle('prod — $600.00').style.opacity).toBe('0.4');
    expect(screen.getByTitle('staging — $300.00').style.opacity).toBe('1');
    same.unmount();

    renderWidget({ focus: { ...initialFocusState, hoveredDimension: REGION, hoveredEntity: 'staging' } });
    await ranked();
    expect(screen.getByTitle('prod — $600.00').style.opacity).toBe('1');
  });

  it('titles itself with a group-by picker that regroups the bars', async () => {
    const { user, api } = renderWidget();
    await ranked();

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(await screen.findByRole('button', { name: 'Region' }));

    await waitFor(() => { expect(api.calls.at(-1)?.groupBy).toBe(REGION); });
    expect(await screen.findByRole('button', { name: 'Region' })).toBeDefined();
  });

  it('uses the spec title when there is one', async () => {
    renderWidget({ spec: { ...SPEC, title: 'Top accounts' } });
    await ranked();

    expect(screen.getByText('Top accounts')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Account' })).toBeNull();
  });

  it('shows the loader while the query is in flight', () => {
    const api = new CostsApi();
    api.current = () => new Promise<CostResult>(() => undefined);
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

describe('TopNBarWidget — previous period', () => {
  it('badges each bar with its change against the previous period', async () => {
    const { api } = renderWidget({ compareEnabled: true });

    await screen.findByText('↑20.0%');
    expect(within(screen.getByTitle('prod — $600.00')).getByText('↑20.0%').className).toContain('text-negative');
    expect(within(screen.getByTitle('staging — $300.00')).getByText('↓25.0%').className).toContain('text-positive');
    // dev is new this period.
    expect(within(screen.getByTitle('dev — $100.00')).queryByText(/[↑↓]/)).toBeNull();
    expect(api.previousCalls()[0]).toMatchObject({ groupBy: ACCOUNT, origin: 'widget:topNBar:account/prev' });
  });

  it('shows no badges when the previous period covers too little of its range', async () => {
    const api = new CostsApi();
    const partial: DateRange = { start: asDateString('2026-02-27'), end: asDateString('2026-02-28') };
    const pending = deferred<CostResult>();
    api.previous = () => pending.promise;
    renderWidget({ api, compareEnabled: true });

    await ranked();
    await waitFor(() => { expect(api.previousCalls()).toHaveLength(1); });
    // Two of ten days is below the 80% coverage bar.
    await settle(pending, costs([['prod', 500]], partial));
    expect(screen.queryByText(/[↑↓]\d/)).toBeNull();
  });
});
