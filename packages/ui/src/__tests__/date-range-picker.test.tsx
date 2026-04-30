import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';

function renderPicker(overrides?: Partial<{
  value: DateRange;
  granularity: Granularity;
  onChange: (range: DateRange, granularity: Granularity) => void;
}>) {
  const onChange = overrides?.onChange ?? vi.fn();
  const value = overrides?.value ?? getDefaultDateRange();
  const granularity = overrides?.granularity ?? 'daily';

  return {
    onChange,
    ...render(
      <DateRangePicker value={value} granularity={granularity} onChange={onChange} />,
    ),
  };
}

afterEach(cleanup);

describe('DateRangePicker', () => {
  it('shows daily, period, and hourly rows', () => {
    renderPicker();
    expect(screen.getByText('Daily')).toBeDefined();
    expect(screen.getByText('Period')).toBeDefined();
    expect(screen.getByText('Hourly')).toBeDefined();
  });

  it('shows daily presets (30d, 90d, 365d, Current month, Last month, Quarter, YTD + Custom)', () => {
    renderPicker();
    expect(screen.getByText('30d')).toBeDefined();
    expect(screen.getByText('90d')).toBeDefined();
    expect(screen.getByText('365d')).toBeDefined();
    expect(screen.getByText('Month')).toBeDefined();
    expect(screen.getByText('Last month')).toBeDefined();
    expect(screen.getByText('Quarter')).toBeDefined();
    expect(screen.getByText('YTD')).toBeDefined();
    expect(screen.getByText('Custom')).toBeDefined();
  });

  it('shows hourly presets (7, 14, 28 days)', () => {
    renderPicker();
    expect(screen.getByText('7 days')).toBeDefined();
    expect(screen.getByText('14 days')).toBeDefined();
    expect(screen.getByText('28 days')).toBeDefined();
  });

  it('30d daily is selected by default', () => {
    renderPicker();
    const dailyBtn = screen.getByText('30d');
    expect(dailyBtn).toBeDefined();
    expect(dailyBtn.className).toContain('bg-accent');
  });

  it('clicking hourly 7 days calls onChange with hourly granularity', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    const user = userEvent.setup();
    await user.click(screen.getByText('7 days'));

    expect(onChange).toHaveBeenCalledOnce();
    const granularity = onChange.mock.calls[0]?.[1] as Granularity;
    expect(granularity).toBe('hourly');
  });

  it('clicking daily 90d calls onChange with daily granularity', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    const user = userEvent.setup();
    await user.click(screen.getByText('90d'));

    expect(onChange).toHaveBeenCalledOnce();
    const granularity = onChange.mock.calls[0]?.[1] as Granularity;
    expect(granularity).toBe('daily');
  });

  it('clicking Custom shows calendar pickers', async () => {
    const { container } = renderPicker();

    // No calendar buttons visible initially
    const initialButtons = container.querySelectorAll('button[class*="justify-start"]');
    expect(initialButtons.length).toBe(0);

    const user = userEvent.setup();
    await user.click(screen.getByText('Custom'));

    // Two calendar picker buttons should now be visible
    const calendarButtons = container.querySelectorAll('button[class*="justify-start"]');
    expect(calendarButtons.length).toBe(2);
  });
});
