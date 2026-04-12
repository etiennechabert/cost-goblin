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
  it('shows daily and hourly rows', () => {
    renderPicker();
    expect(screen.getByText('Daily')).toBeDefined();
    expect(screen.getByText('Hourly')).toBeDefined();
  });

  it('shows daily presets (30, 90, 365 days + Custom)', () => {
    renderPicker();
    expect(screen.getByText('90 days')).toBeDefined();
    expect(screen.getByText('365 days')).toBeDefined();
    expect(screen.getByText('Custom')).toBeDefined();
  });

  it('shows hourly presets (7, 14, 30 days)', () => {
    renderPicker();
    expect(screen.getByText('7 days')).toBeDefined();
    expect(screen.getByText('14 days')).toBeDefined();
  });

  it('30 days daily is selected by default', () => {
    renderPicker();
    const dailyButtons = screen.getAllByText('30 days');
    const dailyBtn = dailyButtons[0];
    expect(dailyBtn).toBeDefined();
    expect(dailyBtn?.className).toContain('bg-bg-secondary');
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

  it('clicking daily 90 days calls onChange with daily granularity', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    const user = userEvent.setup();
    await user.click(screen.getByText('90 days'));

    expect(onChange).toHaveBeenCalledOnce();
    const granularity = onChange.mock.calls[0]?.[1] as Granularity;
    expect(granularity).toBe('daily');
  });

  it('clicking Custom shows date inputs', async () => {
    const { container } = renderPicker();

    expect(container.querySelectorAll('input[type="date"]').length).toBe(0);

    const user = userEvent.setup();
    await user.click(screen.getByText('Custom'));

    expect(container.querySelectorAll('input[type="date"]').length).toBe(2);
  });
});
