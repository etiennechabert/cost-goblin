import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDateString } from '@costgoblin/core/browser';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange } from '../components/date-range-picker.js';

function renderPicker(overrides?: Partial<{
  value: DateRange;
  onChange: (range: DateRange) => void;
}>) {
  const onChange = overrides?.onChange ?? vi.fn();
  const value = overrides?.value ?? getDefaultDateRange();

  return {
    onChange,
    ...render(
      <DateRangePicker value={value} onChange={onChange} />,
    ),
  };
}

afterEach(cleanup);

describe('DateRangePicker', () => {
  it('shows preset buttons (7 days, 30 days, 90 days, Custom)', () => {
    renderPicker();
    expect(screen.getByText('7 days')).toBeDefined();
    expect(screen.getByText('30 days')).toBeDefined();
    expect(screen.getByText('90 days')).toBeDefined();
    expect(screen.getByText('Custom')).toBeDefined();
  });

  it('30 days is selected by default when given default range', () => {
    renderPicker();
    const btn30d = screen.getByText('30 days');
    expect(btn30d.className).toContain('bg-bg-secondary');

    const btn7d = screen.getByText('7 days');
    expect(btn7d.className).not.toContain('bg-bg-secondary');
  });

  it('clicking 7d calls onChange with 7-day range', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    const user = userEvent.setup();
    await user.click(screen.getByText('7 days'));

    expect(onChange).toHaveBeenCalledOnce();
    const range = onChange.mock.calls[0]?.[0] as DateRange;
    const startDate = new Date(range.start);
    const endDate = new Date(range.end);
    const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
    expect(diffDays).toBe(7);
  });

  it('clicking Custom shows date inputs', async () => {
    const { container } = renderPicker();

    expect(container.querySelectorAll('input[type="date"]').length).toBe(0);

    const user = userEvent.setup();
    await user.click(screen.getByText('Custom'));

    expect(container.querySelectorAll('input[type="date"]').length).toBe(2);
  });

  it('custom date inputs update the range', async () => {
    const onChange = vi.fn();
    const defaultRange = getDefaultDateRange();
    const { container } = renderPicker({ onChange });

    onChange.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByText('Custom'));

    const dateInputs = container.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBe(2);

    const startInput = dateInputs[0] as HTMLInputElement;
    const newStart = asDateString('2026-01-01');

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(startInput, newStart);
    startInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenCalled();
    const lastCallIndex = onChange.mock.calls.length - 1;
    const range = onChange.mock.calls[lastCallIndex]?.[0] as DateRange;
    expect(range.start).toBe(newStart);
    expect(range.end).toBe(defaultRange.end);
  });
});
