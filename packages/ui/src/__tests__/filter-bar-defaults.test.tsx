import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Dimension, DimensionId, FilterMap } from '@costgoblin/core/browser';
import { asDimensionId, asTagValue } from '@costgoblin/core/browser';
import { FilterBar } from '../components/filter-bar.js';

interface FilterValue { value: string; label: string; count: number }

const DIMENSIONS: Dimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
  { name: asDimensionId('service'), label: 'Service', field: 'service' },
  { tagName: 'team', label: 'Team', concept: 'owner' },
  { tagName: 'env', label: 'Environment', concept: 'environment' },
];

const TEAM = asDimensionId('tag_team');
const ENV = asDimensionId('tag_env');
const SERVICE = asDimensionId('service');

function values(...names: string[]): FilterValue[] {
  return names.map((name, i) => ({ value: name, label: name, count: 1_000 * (names.length - i) }));
}

function renderBar(props: {
  filters?: FilterMap;
  defaults?: FilterMap | undefined;
  getFilterValues?: (dimensionId: DimensionId, currentFilters: FilterMap) => Promise<FilterValue[]>;
} = {}) {
  const onFilterChange = vi.fn<(filters: FilterMap) => void>();
  const getFilterValues = props.getFilterValues ?? (() => Promise.resolve(values('platform', 'data')));
  const user = userEvent.setup();
  return {
    onFilterChange,
    user,
    ...render(
      <FilterBar
        dimensions={DIMENSIONS}
        filters={props.filters ?? {}}
        onFilterChange={onFilterChange}
        getFilterValues={getFilterValues}
        defaults={props.defaults}
      />,
    ),
  };
}

describe('FilterBar — Reset defaults', () => {
  const defaults: FilterMap = {
    [ENV]: [asTagValue('prod'), asTagValue('staging')],
    [TEAM]: [asTagValue('platform')],
  };

  it('is hidden while the filters still match the defaults, in any order', () => {
    renderBar({
      defaults,
      filters: { [TEAM]: [asTagValue('platform')], [ENV]: [asTagValue('staging'), asTagValue('prod')] },
    });
    expect(screen.queryByRole('button', { name: 'Reset defaults' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDefined();
  });

  it.each<{ why: string; filters: FilterMap }>([
    { why: 'a default was cleared', filters: { [TEAM]: [asTagValue('platform')] } },
    { why: 'another dim replaced a default', filters: { [TEAM]: [asTagValue('platform')], [SERVICE]: [asTagValue('Amazon EC2')] } },
    { why: 'a value was removed', filters: { [ENV]: [asTagValue('prod')], [TEAM]: [asTagValue('platform')] } },
    { why: 'a value was swapped', filters: { [ENV]: [asTagValue('prod'), asTagValue('dev')], [TEAM]: [asTagValue('platform')] } },
    { why: 'everything was cleared', filters: {} },
  ])('appears once $why, and restores the defaults', async ({ filters }) => {
    const { onFilterChange, user } = renderBar({ defaults, filters });
    await user.click(screen.getByRole('button', { name: 'Reset defaults' }));
    expect(onFilterChange).toHaveBeenCalledWith(defaults);
  });

  it('never appears for an empty defaults set', () => {
    renderBar({ defaults: {}, filters: { [TEAM]: [asTagValue('data')] } });
    expect(screen.queryByRole('button', { name: 'Reset defaults' })).toBeNull();
  });
});

describe('FilterBar — clearing a single dimension', () => {
  const filters: FilterMap = {
    [TEAM]: [asTagValue('platform')],
    [SERVICE]: [asTagValue('Amazon EC2')],
  };

  it('clears one dim from its × button and keeps the others', async () => {
    const { onFilterChange, user } = renderBar({ filters });
    await user.click(screen.getByRole('button', { name: 'Clear Team filter' }));
    expect(onFilterChange).toHaveBeenCalledWith({ [SERVICE]: [asTagValue('Amazon EC2')] });
    // The click did not also open the chip's dropdown.
    expect(screen.queryByPlaceholderText(/^Search Team/)).toBeNull();
  });

  it('clears from the keyboard with Enter or Space only', () => {
    const { onFilterChange } = renderBar({ filters });
    const clear = screen.getByRole('button', { name: 'Clear Service filter' });

    fireEvent.keyDown(clear, { key: 'a' });
    fireEvent.keyDown(clear, { key: 'Tab' });
    expect(onFilterChange).not.toHaveBeenCalled();

    fireEvent.keyDown(clear, { key: 'Enter' });
    fireEvent.keyDown(clear, { key: ' ' });
    expect(onFilterChange).toHaveBeenCalledTimes(2);
    expect(onFilterChange).toHaveBeenLastCalledWith({ [TEAM]: [asTagValue('platform')] });
  });

  it('drops the dim when its dropdown is applied with nothing selected', async () => {
    const { onFilterChange, user } = renderBar({ filters });
    await user.click(screen.getByRole('button', { name: 'Team: platform' }));
    await screen.findByRole('checkbox', { name: 'platform' });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onFilterChange).toHaveBeenCalledWith({ [SERVICE]: [asTagValue('Amazon EC2')] });
  });
});

describe('FilterBar — dropdown', () => {
  it('closes when its chip is clicked again', async () => {
    const { user } = renderBar();
    await user.click(screen.getByRole('button', { name: 'Team' }));
    await screen.findByRole('checkbox', { name: 'platform' });
    await user.click(screen.getByRole('button', { name: 'Team' }));
    expect(screen.queryByPlaceholderText(/^Search Team/)).toBeNull();
  });

  it('reports a search with no match, and closes on a click outside the bar', async () => {
    const { user } = renderBar();
    await user.click(screen.getByRole('button', { name: 'Team' }));
    await screen.findByRole('checkbox', { name: 'platform' });
    await user.type(screen.getByPlaceholderText(/^Search Team/), 'zzz');
    expect(screen.getByText('No values found')).toBeDefined();

    await user.click(document.body);
    expect(screen.queryByPlaceholderText(/^Search Team/)).toBeNull();
  });

  it('clears every dim at once', async () => {
    const { onFilterChange, user } = renderBar({ filters: { [TEAM]: [asTagValue('data')], [SERVICE]: [asTagValue('Amazon S3')] } });
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onFilterChange).toHaveBeenCalledWith({});
  });

  it('applies the draft on Enter in the search box', async () => {
    const { onFilterChange, user } = renderBar();
    await user.click(screen.getByRole('button', { name: 'Environment' }));
    await screen.findByRole('checkbox', { name: 'platform' });
    await user.click(screen.getByRole('checkbox', { name: 'data' }));
    await user.type(screen.getByPlaceholderText(/^Search Environment/), '{Enter}');
    expect(onFilterChange).toHaveBeenCalledWith({ [ENV]: [asTagValue('platform')] });
    expect(screen.queryByPlaceholderText(/^Search Environment/)).toBeNull();
  });

  it.each([
    { rejection: new Error('query cancelled'), why: 'an Error' },
    { rejection: 'socket hang up', why: 'a bare string' },
  ])('says the values failed to load when the lookup rejects with $why', async ({ rejection }) => {
    const getFilterValues = vi.fn<(dim: DimensionId, current: FilterMap) => Promise<FilterValue[]>>().mockRejectedValue(rejection);
    const { user } = renderBar({ getFilterValues });
    await user.click(screen.getByRole('button', { name: 'Service' }));
    expect(await screen.findByText('Failed to load values')).toBeDefined();
  });

  it('ignores answers and failures for a chip the user has moved away from', async () => {
    const pending: { dim: DimensionId; resolve: (v: FilterValue[]) => void; reject: (e: unknown) => void }[] = [];
    const { user } = renderBar({
      getFilterValues: (dim) => new Promise((resolve, reject) => { pending.push({ dim, resolve, reject }); }),
    });

    await user.click(screen.getByRole('button', { name: 'Team' }));
    await user.click(screen.getByRole('button', { name: 'Service' }));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const [team, service, account] = pending;
    if (team === undefined || service === undefined || account === undefined) throw new Error('expected three lookups');
    expect([team.dim, service.dim, account.dim]).toEqual(['tag_team', 'service', 'account']);

    team.resolve(values('platform'));
    service.reject(new Error('stale failure'));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.getByText('Loading…')).toBeDefined();
    expect(screen.queryByText('Failed to load values')).toBeNull();

    account.resolve(values('prod-main'));
    expect(await screen.findByRole('checkbox', { name: 'prod-main' })).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: 'platform' })).toBeNull();
  });

  it('asks for values without the opened dim’s own filter', async () => {
    const getFilterValues = vi.fn<(dim: DimensionId, current: FilterMap) => Promise<FilterValue[]>>(
      () => Promise.resolve(values('platform', 'data')),
    );
    const filters: FilterMap = { [TEAM]: [asTagValue('data')], [ENV]: [asTagValue('prod')] };
    const { user } = renderBar({ filters, getFilterValues });

    await user.click(screen.getByRole('button', { name: 'Team: data' }));
    await waitFor(() => { expect(getFilterValues).toHaveBeenCalledOnce(); });
    expect(getFilterValues).toHaveBeenCalledWith(TEAM, { [ENV]: [asTagValue('prod')] });
    // The active value stays ticked; the others start unticked.
    expect(await screen.findByRole('checkbox', { name: 'data' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'platform' })).toHaveProperty('checked', false);
  });
});
