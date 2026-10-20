import { render, screen, cleanup, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDateString } from '@costgoblin/core/browser';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
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
