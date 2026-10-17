import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RollupStatus, TrendQueryParams, TrendResult, TrendRow } from '@costgoblin/core/browser';
import { asDollars, asEntityRef } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostTrends } from '../views/cost-trends.js';
import { getDefaultDateRange } from '../components/date-range-picker.js';
import { monthsInRange } from '../lib/dates.js';

function row(entity: string, currentCost: number, previousCost: number): TrendRow {
  const delta = currentCost - previousCost;
  return {
    entity: asEntityRef(entity),
    currentCost: asDollars(currentCost),
    previousCost: asDollars(previousCost),
    delta: asDollars(delta),
    percentChange: previousCost === 0 ? 0 : (delta / previousCost) * 100,
  };
}

/** `shared` resolves to one name from two accounts moving in opposite
 *  directions, so the backend reports it in both buckets. `newbie` had no
 *  spend before; `idle` had none either side. */
const MIXED: TrendResult = {
  increases: [row('platform', 1_000, 600), row('newbie', 500, 0), row('shared', 300, 100)],
  savings: [row('shared', 100, 400), row('idle', 0, 0)],
  totalIncrease: asDollars(1_100),
  totalSavings: asDollars(300),
};

class TrendsApi extends MockCostApi {
  readonly trendCalls: TrendQueryParams[] = [];
  result: TrendResult = MIXED;

  override queryTrends(params?: TrendQueryParams): Promise<TrendResult> {
    if (params !== undefined) this.trendCalls.push(params);
    return Promise.resolve(this.result);
  }
}

function renderTrends(
  api: TrendsApi = new TrendsApi(),
  props: { onEntityClick?: (entity: string, dimension: string) => void; rollupStatus?: RollupStatus } = {},
) {
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <CostTrends {...props} />
      </CostApiProvider>,
    ),
  };
}

/** Entity column, then the change column, of every table row. */
function tableRows(): { entity: string; delta: string; change: string }[] {
  const body = screen.getByRole('table').querySelector('tbody');
  if (body === null) throw new Error('no table body');
  return within(body).getAllByRole('row').map((tr) => {
    const cells = within(tr).getAllByRole('cell').map(td => td.textContent);
    return { entity: cells[0] ?? '', delta: cells[3] ?? '', change: cells[4] ?? '' };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CostTrends — netting and totals', () => {
  it('nets an entity reported in both buckets and rates brand-new spend at +100%', async () => {
    renderTrends();
    expect(await screen.findByText('4 items · +$900.00 increase · -$100.00 savings')).toBeDefined();
    const rows = tableRows();
    expect(rows.map(r => r.entity)).toEqual(['newbie', 'platform', 'shared', 'idle']);
    expect(rows.map(r => r.change)).toEqual(['+100.0%', '+66.7%', '-20.0%', '+0.0%']);
    expect(rows[0]?.delta).toBe('+$500.00');
    expect(rows[1]?.delta).toBe('+$400.00');
    // Netted to a $100 saving (+$200 − $300); whichever side of the "$" the minus sits.
    expect(rows[2]?.delta).toMatch(/^(-\$|\$-)100\.00$/);
    expect(rows[3]?.delta).toBe('$0.00');
  });

  it('narrows to one direction with its own total', async () => {
    const { user } = renderTrends();
    await screen.findByText('4 items · +$900.00 increase · -$100.00 savings');

    await user.click(screen.getByRole('button', { name: 'Increase' }));
    expect(screen.getByText('2 items · +$900.00 total increase')).toBeDefined();
    expect(tableRows().map(r => r.entity)).toEqual(['newbie', 'platform']);

    await user.click(screen.getByRole('button', { name: 'Savings' }));
    expect(screen.getByText(/^1 items? · -\$100\.00 total savings$/)).toBeDefined();
    expect(tableRows().map(r => r.entity)).toEqual(['shared']);
  });

  it.each([
    { result: { increases: [row('platform', 1_000, 600)], savings: [] }, direction: 'Savings', empty: 'No savings above thresholds' },
    { result: { increases: [], savings: [row('infra', 100, 400)] }, direction: 'Increase', empty: 'No increases above thresholds' },
    { result: { increases: [], savings: [] }, direction: 'All', empty: 'No changes above thresholds' },
  ])('says "$empty" when that direction has nothing', async ({ result, direction, empty }) => {
    const api = new TrendsApi();
    api.result = { ...result, totalIncrease: asDollars(0), totalSavings: asDollars(0) };
    const { user } = renderTrends(api);
    await screen.findByText(/items ·/);

    await user.click(screen.getByRole('button', { name: direction }));
    expect(screen.getByText(empty)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the query error', async () => {
    const api = new TrendsApi();
    vi.spyOn(api, 'queryTrends').mockRejectedValue(new Error('Conversion Error: bad date'));
    renderTrends(api);
    expect(await screen.findByText('Conversion Error: bad date')).toBeDefined();
  });
});

describe('CostTrends — controls', () => {
  it('re-queries for another dimension and the thresholds', async () => {
    const { api, user } = renderTrends();
    await waitFor(() => { expect(api.trendCalls).toHaveLength(1); });
    expect(api.trendCalls[0]?.groupBy).toBe('provider');

    await user.click(screen.getByRole('button', { name: 'Team' }));
    await waitFor(() => { expect(api.trendCalls.at(-1)?.groupBy).toBe('tag_team'); });
    expect(api.trendCalls.at(-1)?.origin).toBe('trends:tag_team');

    fireEvent.change(screen.getByLabelText('Min $'), { target: { value: '250' } });
    await waitFor(() => { expect(api.trendCalls.at(-1)?.deltaThreshold).toBe(250); });
    fireEvent.change(screen.getByLabelText('Min %'), { target: { value: '15' } });
    await waitFor(() => { expect(api.trendCalls.at(-1)?.percentThreshold).toBe(15); });
    expect(api.trendCalls.at(-1)?.deltaThreshold).toBe(250);
  });

  it('switches the bubble scale', async () => {
    const { user } = renderTrends();
    await screen.findByText('4 items · +$900.00 increase · -$100.00 savings');

    const linear = screen.getByRole('button', { name: 'Linear' });
    expect(screen.getByRole('button', { name: 'Log 10' }).className).toContain('bg-bg-tertiary');
    await user.click(linear);
    expect(linear.className.split(' ')).toContain('bg-bg-tertiary');
    expect(screen.getByRole('button', { name: 'Log 10' }).className.split(' ')).not.toContain('bg-bg-tertiary');
  });

  it('drills into an entity on the active dimension, and ignores clicks without a handler', async () => {
    const onEntityClick = vi.fn<(entity: string, dimension: string) => void>();
    const { user, unmount } = renderTrends(new TrendsApi(), { onEntityClick });
    await user.click(await screen.findByRole('button', { name: 'platform' }));
    expect(onEntityClick).toHaveBeenCalledWith('platform', 'provider');
    unmount();

    const second = renderTrends();
    await second.user.click(await screen.findByRole('button', { name: 'platform' }));
    expect(screen.getByText('4 items · +$900.00 increase · -$100.00 savings')).toBeDefined();
    expect(onEntityClick).toHaveBeenCalledOnce();
  });

  it('re-queries a new period, cancelling the queries still running for the old one', async () => {
    const api = new TrendsApi();
    const cancel = vi.spyOn(api, 'cancelPendingQueries');
    const { user } = renderTrends(api);
    await waitFor(() => { expect(api.trendCalls).toHaveLength(1); });
    expect(cancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    await user.click(await screen.findByRole('button', { name: 'Last 90 days' }));

    await waitFor(() => { expect(api.trendCalls).toHaveLength(2); });
    expect(cancel).toHaveBeenCalledOnce();
    // Trends only read the daily tier: the picker offers no hourly toggle.
    expect(screen.queryByRole('button', { name: 'Hourly' })).toBeNull();
  });
});

describe('CostTrends — rollup gate', () => {
  it('shows the build overlay instead of the controls while the viewed months are building', async () => {
    const months = monthsInRange(getDefaultDateRange());
    const building: RollupStatus = { state: 'computing', done: 0, total: months.length, periods: months, active: months.slice(0, 1) };
    renderTrends(new TrendsApi(), { rollupStatus: building });

    expect(await screen.findByText('Preparing your cost data')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Increase' })).toBeNull();
  });

  it('renders normally once the rollup is ready', async () => {
    renderTrends(new TrendsApi(), { rollupStatus: { state: 'ready', periods: 12 } });
    expect(await screen.findByText('4 items · +$900.00 increase · -$100.00 savings')).toBeDefined();
    expect(screen.queryByText('Preparing your cost data')).toBeNull();
  });
});
