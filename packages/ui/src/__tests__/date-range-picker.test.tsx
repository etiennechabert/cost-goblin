import { render, screen, cleanup, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { asDateString, asHourString } from '@costgoblin/core/browser';
import type { DataInventoryResult } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DateRangePicker, getDefaultDateRange, lastNDaysRange, switchGranularity } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';

function renderPicker(overrides?: Partial<{
  value: DateRange;
  granularity: Granularity;
  onChange: (range: DateRange, granularity: Granularity) => void;
  hideHourly: boolean;
}>) {
  const onChange = overrides?.onChange ?? vi.fn();
  const value = overrides?.value ?? getDefaultDateRange();
  const granularity = overrides?.granularity ?? 'daily';

  return {
    onChange,
    ...render(
      <DateRangePicker value={value} granularity={granularity} onChange={onChange} hideHourly={overrides?.hideHourly ?? false} />,
    ),
  };
}

afterEach(cleanup);

describe('DateRangePicker', () => {
  it('shows active preset label on trigger button', () => {
    renderPicker();
    expect(screen.getByText('Last 30 days')).toBeDefined();
  });

  it('opens popover with preset sections on click', async () => {
    renderPicker();
    const user = userEvent.setup();
    await user.click(screen.getByText('Last 30 days'));

    expect(screen.getByText('Days')).toBeDefined();
    expect(screen.getByText('Period')).toBeDefined();
  });

  it('shows all presets when open', async () => {
    renderPicker();
    const user = userEvent.setup();
    await user.click(screen.getByText('Last 30 days'));

    expect(screen.getByText('Last 7 days')).toBeDefined();
    expect(screen.getByText('Last 14 days')).toBeDefined();
    expect(screen.getByText('Last 90 days')).toBeDefined();
    expect(screen.getByText('Last 365 days')).toBeDefined();
    expect(screen.getByText('This month')).toBeDefined();
    expect(screen.getByText('Last month')).toBeDefined();
    expect(screen.getByText('This quarter')).toBeDefined();
    expect(screen.getByText('Last quarter')).toBeDefined();
    expect(screen.getByText('This year')).toBeDefined();
    expect(screen.getByText('Last year')).toBeDefined();
    expect(screen.getByText('Custom range…')).toBeDefined();
  });

  it('clicking a preset calls onChange and closes popover', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const user = userEvent.setup();

    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Last 90 days'));

    expect(onChange).toHaveBeenCalledOnce();
    const granularity = onChange.mock.calls[0]?.[1] as Granularity;
    expect(granularity).toBe('daily');
  });

  it('reports the days of a "Last N days" preset, and none for a calendar period', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const user = userEvent.setup();

    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Last 90 days'));
    expect(onChange.mock.calls[0]?.[2]).toBe(90);

    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Last month'));
    expect(onChange.mock.calls[1]).toHaveLength(3);
    expect(onChange.mock.calls[1]?.[2]).toBeUndefined();
  });

  it('Last 7 days preset stays daily without hourly tier configured', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const user = userEvent.setup();

    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Last 7 days'));

    expect(onChange).toHaveBeenCalledOnce();
    const granularity = onChange.mock.calls[0]?.[1] as Granularity;
    expect(granularity).toBe('daily');
  });

  it('daily-only (hideHourly) keeps Last 7 days as a daily preset and drops the toggle', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange, hideHourly: true });
    const user = userEvent.setup();

    expect(screen.queryByRole('button', { name: 'Hourly' })).toBeNull();
    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Last 7 days'));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[1]).toBe('daily');
  });

  it('shows custom range calendar when Custom range is clicked', async () => {
    renderPicker();
    const user = userEvent.setup();

    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Custom range…'));

    expect(screen.getByText('From')).toBeDefined();
    expect(screen.getByText('To')).toBeDefined();
    // A single range calendar grid is shown (not two separate date inputs).
    expect(screen.getByRole('grid')).toBeDefined();
  });

  it('picking two days in the range calendar commits a full range', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const user = userEvent.setup();

    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Custom range…'));

    const grid = screen.getByRole('grid');
    const enabledDays = within(grid)
      .getAllByRole('button')
      .filter(btn => !btn.hasAttribute('disabled'));

    const first = enabledDays[0];
    const last = enabledDays[enabledDays.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first && last) {
      // First click starts a fresh range (no commit yet); second click completes it.
      await user.click(first);
      await user.click(last);
    }

    expect(onChange).toHaveBeenCalled();
    const calls = onChange.mock.calls;
    const range = calls[calls.length - 1]?.[0] as DateRange;
    expect(range.start <= range.end).toBe(true);
  });
});

describe('DateRangePicker calendar periods and the freshness lag', () => {
  afterEach(() => { vi.useRealTimers(); });

  // Fake only Date so userEvent's timers keep running.
  function renderOn(isoNow: string, lagDays: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(isoNow));
    const onChange = vi.fn();
    render(<DateRangePicker value={getDefaultDateRange(lagDays)} granularity="daily" onChange={onChange} hideHourly lagDays={lagDays} />);
    return { onChange, user: userEvent.setup() };
  }

  it('stops a period at the newest day the lag allows', async () => {
    const { onChange, user } = renderOn('2026-10-20T12:00:00Z', 7);
    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('This month'));
    expect(onChange.mock.calls[0]?.[0]).toEqual({ start: asDateString('2026-10-01'), end: asDateString('2026-10-13') });
  });

  it('disables a period that starts after it', async () => {
    const { onChange, user } = renderOn('2026-10-03T12:00:00Z', 7);
    await user.click(screen.getByText('Last 30 days'));
    const thisMonth = screen.getByRole('button', { name: 'This month' });
    expect(thisMonth).toHaveProperty('disabled', true);
    expect(thisMonth.getAttribute('title')).toContain('2026-09-26');
    await user.click(thisMonth);
    expect(onChange).not.toHaveBeenCalled();
    // Last month still has its first 26 days.
    await user.click(screen.getByRole('button', { name: 'Last month' }));
    expect(onChange.mock.calls[0]?.[0]).toEqual({ start: asDateString('2026-09-01'), end: asDateString('2026-09-26') });
  });
});

/** A mock whose daily tier holds local data back to January 2025 (and one
 *  period that is only on the remote, which must not count as local). */
class InventoryApi extends MockCostApi {
  override getDataInventory(): Promise<DataInventoryResult> {
    const period = (name: string, localStatus: 'missing' | 'repartitioned') => ({ period: name, files: [], totalSize: 0, localStatus });
    return Promise.resolve({
      periods: [period('2024-11', 'missing'), period('2025-01', 'repartitioned'), period('2026-09', 'repartitioned')],
      totalRemoteSize: 0,
      totalLocalPeriods: 2,
      totalRemotePeriods: 3,
      lastSync: null,
      local: { periods: ['2025-01', '2026-09'], diskBytes: 0, oldestPeriod: '2025-01', newestPeriod: '2026-09' },
    });
  }
}

const MARCH_TO_OCT_2026: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-10-31') };

describe('DateRangePicker monthly and weekly modes', () => {
  afterEach(() => { vi.useRealTimers(); });

  type OnChange = (range: DateRange, granularity: Granularity, lastNDays?: number) => void;

  // Fake only Date so userEvent's timers keep running. Today is 2026-10-21 and
  // the lag is 2 days, so the newest day is 2026-10-19.
  function renderMode(granularity: Granularity, value: DateRange, api: MockCostApi = new MockCostApi()) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    const onChange = vi.fn<OnChange>();
    render(
      <CostApiProvider value={api}>
        <DateRangePicker value={value} granularity={granularity} onChange={onChange} lagDays={2} />
      </CostApiProvider>,
    );
    return { onChange, user: userEvent.setup() };
  }

  const presetButtons = () => screen.getAllByRole('button')
    .map(b => b.textContent)
    .filter(text => /^(Last|This|All) /.test(text));

  it('orders the toggle Monthly, Weekly, Daily, Hourly', () => {
    renderMode('daily', getDefaultDateRange(2));
    const order = screen.getAllByRole('button')
      .map(b => b.textContent)
      .filter(text => ['Monthly', 'Weekly', 'Daily', 'Hourly'].includes(text));
    expect(order).toEqual(['Monthly', 'Weekly', 'Daily', 'Hourly']);
  });

  it('renders no toggle at all with hideHourly', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    render(<DateRangePicker value={getDefaultDateRange(2)} granularity="daily" onChange={vi.fn()} hideHourly lagDays={2} />);
    for (const name of ['Monthly', 'Weekly', 'Daily', 'Hourly']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('lists the seven monthly presets, and none are available before the inventory loads "All synced data"', async () => {
    const { user } = renderMode('monthly', MARCH_TO_OCT_2026);
    await user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    expect(presetButtons()).toEqual(['Last 3 months', 'Last 6 months', 'Last 12 months', 'Last 24 months', 'This year', 'Last year']);
  });

  it('gives whole months for "Last 3 months", counting the current one', async () => {
    const { onChange, user } = renderMode('monthly', MARCH_TO_OCT_2026);
    await user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    await user.click(screen.getByRole('button', { name: 'Last 3 months' }));
    expect(onChange).toHaveBeenCalledWith({ start: '2026-08-01', end: '2026-10-31' }, 'monthly', undefined);
  });

  it('gives whole calendar years for "This year" and "Last year"', async () => {
    const { onChange, user } = renderMode('monthly', MARCH_TO_OCT_2026);
    await user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    await user.click(screen.getByRole('button', { name: 'This year' }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2026-01-01', end: '2026-12-31' }, 'monthly', undefined);
    await user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    await user.click(screen.getByRole('button', { name: 'Last year' }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2025-01-01', end: '2025-12-31' }, 'monthly', undefined);
  });

  it('lists the five weekly presets and gives whole weeks for "Last 4 weeks"', async () => {
    const { onChange, user } = renderMode('weekly', { start: asDateString('2026-08-10'), end: asDateString('2026-10-25') });
    await user.click(screen.getByRole('button', { name: /W33 2026/ }));
    expect(presetButtons()).toEqual(['Last 4 weeks', 'Last 6 weeks', 'Last 12 weeks', 'Last 26 weeks', 'Last 52 weeks']);
    await user.click(screen.getByRole('button', { name: 'Last 4 weeks' }));
    expect(onChange).toHaveBeenCalledWith({ start: '2026-09-28', end: '2026-10-25' }, 'weekly', undefined);
  });

  it('hides "All synced data" until the oldest local daily period is known, then spans from it', async () => {
    const first = renderMode('monthly', MARCH_TO_OCT_2026);
    await first.user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    expect(screen.queryByRole('button', { name: 'All synced data' })).toBeNull();
    cleanup();

    const { onChange, user } = renderMode('monthly', MARCH_TO_OCT_2026, new InventoryApi());
    await user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    const all = await screen.findByRole('button', { name: 'All synced data' });
    await user.click(all);
    expect(onChange).toHaveBeenCalledWith({ start: '2025-01-01', end: '2026-10-31' }, 'monthly', undefined);
  });

  it('labels an unpreset whole-period range by its first and last period', () => {
    renderMode('monthly', { start: asDateString('2026-08-01'), end: asDateString('2026-10-31') });
    expect(screen.getByText('Last 3 months')).toBeDefined();
    cleanup();
    renderMode('monthly', MARCH_TO_OCT_2026);
    expect(screen.getByText('Mar 2026 – Oct 2026')).toBeDefined();
    cleanup();
    renderMode('weekly', { start: asDateString('2026-09-28'), end: asDateString('2026-10-25') });
    expect(screen.getByText('Last 4 weeks')).toBeDefined();
    cleanup();
    renderMode('weekly', { start: asDateString('2026-09-28'), end: asDateString('2026-10-18') });
    expect(screen.getByText('W40 2026 – W42 2026')).toBeDefined();
  });

  it('widens to whole periods when a toggle button is pressed', async () => {
    const { onChange, user } = renderMode('daily', { start: asDateString('2026-03-15'), end: asDateString('2026-10-19') });
    await user.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2026-03-01', end: '2026-10-31' }, 'monthly');
    await user.click(screen.getByRole('button', { name: 'Weekly' }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2026-03-09', end: '2026-10-25' }, 'weekly');
  });

  it('shows the month grid, not the day calendar, for a Monthly custom range', async () => {
    const { onChange, user } = renderMode('monthly', MARCH_TO_OCT_2026);
    await user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    await user.click(screen.getByText('Custom range…'));
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous year' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Jan' }));
    await user.click(screen.getByRole('button', { name: 'Sep' }));
    expect(onChange).toHaveBeenCalledWith({ start: '2026-01-01', end: '2026-09-30' }, 'monthly');
  });

  it('disables the months after the newest available day in the Monthly custom range', async () => {
    const { user } = renderMode('monthly', MARCH_TO_OCT_2026);
    await user.click(screen.getByRole('button', { name: /Mar 2026/ }));
    await user.click(screen.getByText('Custom range…'));
    expect(screen.getByRole('button', { name: 'Oct' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Nov' }).hasAttribute('disabled')).toBe(true);
  });

  it('widens a Weekly custom range to whole ISO weeks', async () => {
    const { onChange, user } = renderMode('weekly', { start: asDateString('2026-09-28'), end: asDateString('2026-10-25') });
    await user.click(screen.getByRole('button', { name: 'Last 4 weeks' }));
    await user.click(screen.getByText('Custom range…'));
    await user.click(screen.getByRole('button', { name: /October 8th, 2026/ }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /October 15th, 2026/ }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ start: '2026-10-05', end: '2026-10-18' }, 'weekly');
  });

  it('starts weeks on Monday and numbers them by ISO week in the Weekly calendar', async () => {
    const { user } = renderMode('weekly', { start: asDateString('2026-09-28'), end: asDateString('2026-10-25') });
    await user.click(screen.getByRole('button', { name: 'Last 4 weeks' }));
    await user.click(screen.getByText('Custom range…'));
    const grid = screen.getByRole('grid');
    const headers = within(grid).getAllByRole('columnheader', { hidden: true }).map(h => h.textContent);
    expect(headers).toEqual(['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(within(grid).getByRole('rowheader', { name: 'Week 42' }).textContent).toBe('42');
    // The week of Monday 2026-10-12 is labelled with its own number.
    const monday = within(grid).getByRole('button', { name: /October 12th, 2026/ });
    expect(monday.closest('tr')?.querySelector('[role="rowheader"]')?.textContent).toBe('42');
  });

  it('highlights the whole week of the first day picked while the end is pending', async () => {
    const { user } = renderMode('weekly', { start: asDateString('2026-09-28'), end: asDateString('2026-10-25') });
    await user.click(screen.getByRole('button', { name: 'Last 4 weeks' }));
    await user.click(screen.getByText('Custom range…'));
    await user.click(screen.getByRole('button', { name: /October 8th, 2026/ }));
    const grid = screen.getByRole('grid');
    for (const name of [/October 5th, 2026/, /October 11th, 2026/]) {
      expect(within(grid).getByRole('button', { name }).closest('td')?.className).toContain('bg-accent/20');
    }
    expect(within(grid).getByRole('button', { name: /October 12th, 2026/ }).closest('td')?.className).not.toContain('bg-accent/20');
    expect(within(grid).getByRole('button', { name: /October 4th, 2026/ }).closest('td')?.className).not.toContain('bg-accent/20');
  });
});

describe('switchGranularity', () => {
  const ctx = { newestDay: asDateString('2026-10-19'), hourlyRetentionDays: 30 };
  const march15: DateRange = { start: asDateString('2026-03-15'), end: asDateString('2026-10-19') };

  // Today is 2026-10-21: with 30 days of hourly retention, hourly data reaches
  // back to the first day of the month of 2026-09-21, i.e. 2026-09-01.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('widens daily and hourly ranges to the periods covering them', () => {
    expect(switchGranularity(march15, 'daily', 'monthly', ctx)).toEqual({ start: '2026-03-01', end: '2026-10-31' });
    expect(switchGranularity(march15, 'daily', 'weekly', ctx)).toEqual({ start: '2026-03-09', end: '2026-10-25' });
    const hours: DateRange = { start: asDateString('2026-10-12'), end: asDateString('2026-10-12'), startHour: asHourString('2026-10-12 14:00:00'), endHour: asHourString('2026-10-12 18:00:00') };
    expect(switchGranularity(hours, 'hourly', 'weekly', ctx)).toEqual({ start: '2026-10-12', end: '2026-10-18' });
  });

  it('widens between weekly and monthly in both directions', () => {
    const weeks: DateRange = { start: asDateString('2026-09-28'), end: asDateString('2026-10-25') };
    expect(switchGranularity(weeks, 'weekly', 'monthly', ctx)).toEqual({ start: '2026-09-01', end: '2026-10-31' });
    const months: DateRange = { start: asDateString('2026-10-01'), end: asDateString('2026-10-31') };
    expect(switchGranularity(months, 'monthly', 'weekly', ctx)).toEqual({ start: '2026-09-28', end: '2026-11-01' });
  });

  it('keeps the days of a period range for daily, capping the end at the newest day', () => {
    const march: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-10-31') };
    expect(switchGranularity(march, 'monthly', 'daily', ctx)).toEqual({ start: '2026-03-01', end: '2026-10-19' });
    const past: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-05-31') };
    expect(switchGranularity(past, 'monthly', 'daily', ctx)).toEqual({ start: '2026-03-01', end: '2026-05-31' });
  });

  it('drops hour bounds going from hourly to daily', () => {
    const hours: DateRange = { start: asDateString('2026-10-12'), end: asDateString('2026-10-12'), startHour: asHourString('2026-10-12 14:00:00'), endHour: asHourString('2026-10-12 18:00:00') };
    expect(switchGranularity(hours, 'hourly', 'daily', ctx)).toEqual({ start: '2026-10-12', end: '2026-10-12' });
  });

  it('keeps a range that fits hourly retention, capped at the newest day', () => {
    const recent: DateRange = { start: asDateString('2026-10-01'), end: asDateString('2026-10-19') };
    expect(switchGranularity(recent, 'daily', 'hourly', ctx)).toEqual(recent);
    const thisMonth: DateRange = { start: asDateString('2026-10-01'), end: asDateString('2026-10-31') };
    expect(switchGranularity(thisMonth, 'monthly', 'hourly', ctx)).toEqual({ start: '2026-10-01', end: '2026-10-19' });
  });

  it('keeps a range starting on the first day of the retention month, and not one starting the day before', () => {
    const onBoundary: DateRange = { start: asDateString('2026-09-01'), end: asDateString('2026-10-19') };
    expect(switchGranularity(onBoundary, 'daily', 'hourly', ctx)).toEqual(onBoundary);
    const dayBefore: DateRange = { start: asDateString('2026-08-31'), end: asDateString('2026-10-19') };
    expect(switchGranularity(dayBefore, 'daily', 'hourly', ctx)).toEqual(lastNDaysRange(7, 2));
  });

  it('lands on the last 7 days when a long range does not fit hourly retention', () => {
    const twoYears: DateRange = { start: asDateString('2024-11-01'), end: asDateString('2026-10-31') };
    expect(switchGranularity(twoYears, 'monthly', 'hourly', ctx)).toEqual(lastNDaysRange(7, 2));
    expect(switchGranularity(march15, 'daily', 'hourly', ctx)).toEqual(lastNDaysRange(7, 2));
  });
});
