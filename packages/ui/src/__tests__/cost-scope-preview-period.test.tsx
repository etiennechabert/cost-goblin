import { render, screen, waitFor, within, cleanup, fireEvent } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostScopeView } from '../views/cost-scope.js';
import { daysAgo, getLastMonth } from '../lib/dates.js';

function renderView() {
  const api = new MockCostApi();
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <CostScopeView />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

/** Picks a preset from the preview card's date picker, which shows once
 *  cost-scope.yaml has loaded. */
async function pickPeriod(user: ReturnType<typeof userEvent.setup>, current: string, preset: string): Promise<void> {
  await user.click(within(await screen.findByTestId('cost-scope-preview')).getByText(current));
  await user.click(await screen.findByText(preset));
}

describe('CostScopeView — preview period', () => {
  it('previews the last 30 days, ending at the data freshness lag, by default', async () => {
    const { api } = renderView();
    // DEFAULT_COST_SCOPE lags 2 days; "Last 30 days" is the picker's preset.
    await waitFor(() => { expect(api.costScopePreviewRanges.at(-1)).toEqual({ start: daysAgo(32), end: daysAgo(2) }); });
    expect(within(screen.getByTestId('cost-scope-preview')).getByText('Last 30 days')).toBeDefined();
  });

  it('re-queries the period picked on the preview', async () => {
    const { api, user } = renderView();
    await waitFor(() => { expect(api.costScopePreviewRanges.length).toBeGreaterThan(0); });

    await pickPeriod(user, 'Last 30 days', 'Last 7 days');

    await waitFor(() => { expect(api.costScopePreviewRanges.at(-1)).toEqual({ start: daysAgo(9), end: daysAgo(2) }); });
    expect(within(screen.getByTestId('cost-scope-preview')).getByText('Last 7 days')).toBeDefined();
  });

  it('offers the daily presets other views do, without an hourly toggle', async () => {
    const { user } = renderView();
    await user.click(within(await screen.findByTestId('cost-scope-preview')).getByText('Last 30 days'));
    for (const preset of ['Last 7 days', 'Last 14 days', 'Last 90 days', 'Last 365 days', 'Last month']) {
      expect(screen.getByText(preset)).toBeDefined();
    }
    expect(screen.queryByRole('button', { name: 'Hourly' })).toBeNull();
  });

  it('moves a "last N days" period with the lag being edited', async () => {
    const { api, user } = renderView();
    await pickPeriod(user, 'Last 30 days', 'Last 14 days');
    await waitFor(() => { expect(api.costScopePreviewRanges.at(-1)).toEqual({ start: daysAgo(16), end: daysAgo(2) }); });

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });

    await waitFor(() => { expect(api.costScopePreviewRanges.at(-1)).toEqual({ start: daysAgo(14), end: daysAgo(0) }); });
    expect(within(screen.getByTestId('cost-scope-preview')).getByText('Last 14 days')).toBeDefined();
  });

  it('keeps a calendar period fixed when the lag changes', async () => {
    const { api, user } = renderView();
    await pickPeriod(user, 'Last 30 days', 'Last month');
    const lastMonth = getLastMonth();
    await waitFor(() => { expect(api.costScopePreviewRanges.at(-1)).toEqual(lastMonth); });

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });

    // The lag edit re-runs the preview (the draft changed) over the same dates.
    const before = api.costScopePreviewRanges.length;
    await waitFor(() => { expect(api.costScopePreviewRanges.length).toBeGreaterThan(before); });
    expect(api.costScopePreviewRanges.at(-1)).toEqual(lastMonth);
  });
});
