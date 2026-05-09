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

  it('shows custom range inputs when Custom range is clicked', async () => {
    renderPicker();
    const user = userEvent.setup();

    await user.click(screen.getByText('Last 30 days'));
    await user.click(screen.getByText('Custom range…'));

    expect(screen.getByText('From')).toBeDefined();
    expect(screen.getByText('To')).toBeDefined();
  });
});
