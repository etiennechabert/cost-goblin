import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Dimension, DimensionId, FilterMap } from '@costgoblin/core/browser';
import { asDimensionId, asTagValue } from '@costgoblin/core/browser';
import { FilterBar } from '../components/filter-bar.js';

const dimensions: Dimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'line_item_usage_account_id', displayField: 'account_name' },
  { name: asDimensionId('service'), label: 'Service', field: 'product_service_name' },
  { tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab', aliases: {} },
];

function renderFilterBar(overrides?: Partial<{
  filters: FilterMap;
  onFilterChange: (filters: FilterMap) => void;
  getFilterValues: (dimensionId: DimensionId, currentFilters: FilterMap) => Promise<{ value: string; label: string; count: number }[]>;
}>) {
  const onFilterChange = overrides?.onFilterChange ?? vi.fn();
  const getFilterValues = overrides?.getFilterValues ?? (() => Promise.resolve([
    { value: 'platform', label: 'platform', count: 42300 },
    { value: 'data', label: 'data', count: 31750 },
    { value: 'growth', label: 'growth', count: 18900 },
  ]));

  return {
    onFilterChange,
    getFilterValues,
    ...render(
      <FilterBar
        dimensions={dimensions}
        filters={overrides?.filters ?? {}}
        onFilterChange={onFilterChange}
        getFilterValues={getFilterValues}
      />,
    ),
  };
}

afterEach(cleanup);

describe('FilterBar', () => {
  it('renders dimension chips', () => {
    renderFilterBar();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Service')).toBeDefined();
    expect(screen.getByText('Team')).toBeDefined();
  });

  it('clicking a chip opens dropdown with loading then values', async () => {
    let resolveValues: ((v: { value: string; label: string; count: number }[]) => void) | undefined;
    const delayedGetFilterValues = () =>
      new Promise<{ value: string; label: string; count: number }[]>((resolve) => {
        resolveValues = resolve;
      });

    renderFilterBar({ getFilterValues: delayedGetFilterValues });

    const user = userEvent.setup();
    await user.click(screen.getByText('Team'));

    expect(screen.getByText(/Loading/)).toBeDefined();

    if (resolveValues !== undefined) {
      resolveValues([
        { value: 'platform', label: 'platform', count: 42300 },
        { value: 'data', label: 'data', count: 31750 },
        { value: 'growth', label: 'growth', count: 18900 },
      ]);
    }

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });
    expect(screen.getByText('data')).toBeDefined();
    expect(screen.getByText('growth')).toBeDefined();
  });

  it('values in dropdown show formatted dollar amounts', async () => {
    renderFilterBar();

    const user = userEvent.setup();
    await user.click(screen.getByText('Team'));

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });

    expect(screen.getByText('$42.3k')).toBeDefined();
    expect(screen.getByText('$31.8k')).toBeDefined();
    expect(screen.getByText('$18.9k')).toBeDefined();
  });

  it('checking a value and clicking Apply calls onFilterChange with array', async () => {
    const onFilterChange = vi.fn();
    renderFilterBar({ onFilterChange });

    const user = userEvent.setup();
    await user.click(screen.getByText('Team'));

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });

    await user.click(screen.getByText('platform'));
    await user.click(screen.getByText('Apply'));

    expect(onFilterChange).toHaveBeenCalledOnce();
    const callArg = onFilterChange.mock.calls[0]?.[0] as FilterMap;
    expect(callArg[asDimensionId('tag_team')]).toEqual([asTagValue('platform')]);
  });

  it('multi-select: checking multiple values applies all', async () => {
    const onFilterChange = vi.fn();
    renderFilterBar({ onFilterChange });

    const user = userEvent.setup();
    await user.click(screen.getByText('Team'));

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });

    await user.click(screen.getByText('platform'));
    await user.click(screen.getByText('data'));
    await user.click(screen.getByText('Apply'));

    expect(onFilterChange).toHaveBeenCalledOnce();
    const callArg = onFilterChange.mock.calls[0]?.[0] as FilterMap;
    expect(callArg[asDimensionId('tag_team')]).toEqual([asTagValue('platform'), asTagValue('data')]);
  });

  it('"Only" button selects just that value', async () => {
    const onFilterChange = vi.fn();
    renderFilterBar({
      onFilterChange,
      filters: { [asDimensionId('tag_team')]: [asTagValue('platform'), asTagValue('data')] },
    });

    const user = userEvent.setup();
    await user.click(screen.getByText(/Team/));

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });

    const onlyButtons = screen.getAllByText('only');
    const secondOnly = onlyButtons[1];
    expect(secondOnly).toBeDefined();
    if (secondOnly === undefined) return;
    await user.click(secondOnly);
    await user.click(screen.getByText('Apply'));

    expect(onFilterChange).toHaveBeenCalledOnce();
    const callArg = onFilterChange.mock.calls[0]?.[0] as FilterMap;
    expect(callArg[asDimensionId('tag_team')]).toEqual([asTagValue('data')]);
  });

  it('active filter shows value and clear button', () => {
    const filters: FilterMap = { [asDimensionId('tag_team')]: [asTagValue('platform')] };
    renderFilterBar({ filters });

    expect(screen.getByText('Team: platform')).toBeDefined();
    expect(screen.getByLabelText('Clear Team filter')).toBeDefined();
  });

  it('multi-value badge shows count', () => {
    const filters: FilterMap = { [asDimensionId('tag_team')]: [asTagValue('platform'), asTagValue('data')] };
    renderFilterBar({ filters });

    expect(screen.getByText('Team \u00b7 2')).toBeDefined();
  });

  it('clear all button appears when filters are active', () => {
    const filters: FilterMap = { [asDimensionId('tag_team')]: [asTagValue('platform')] };
    renderFilterBar({ filters });

    expect(screen.getByText('Clear all')).toBeDefined();
  });

  it('escape key closes dropdown', async () => {
    renderFilterBar();

    const user = userEvent.setup();
    await user.click(screen.getByText('Team'));

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByText('platform')).toBeNull();
    });
  });
});
