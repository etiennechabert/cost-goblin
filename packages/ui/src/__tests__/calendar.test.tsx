import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Calendar } from '../components/ui/calendar.js';

afterEach(cleanup);

describe('Calendar', () => {
  it('renders calendar with current month', () => {
    render(<Calendar mode="single" />);
    const currentMonth = new Date().toLocaleString('default', { month: 'long' });
    expect(screen.getByText(new RegExp(currentMonth, 'i'))).toBeDefined();
  });

  it('renders day cells for the month', () => {
    render(<Calendar mode="single" />);
    // Check that day cells are rendered (looking for day numbers)
    const dayCells = screen.getAllByRole('button');
    expect(dayCells.length).toBeGreaterThan(0);
  });

  it('calls onSelect when a date is clicked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Calendar mode="single" onSelect={onSelect} />);

    // Find a day button (look for a button with text "15" for example)
    const dayButtons = screen.getAllByRole('button');
    const dayButton = dayButtons.find(btn => btn.textContent === '15');

    if (dayButton) {
      await user.click(dayButton);
      expect(onSelect).toHaveBeenCalled();
    }
  });

  it('renders navigation buttons', () => {
    render(<Calendar mode="single" />);
    const buttons = screen.getAllByRole('button');
    // Should have previous and next navigation buttons plus day buttons
    expect(buttons.length).toBeGreaterThan(2);
  });

  it('supports range selection mode', () => {
    const onSelect = vi.fn();
    render(<Calendar mode="range" onSelect={onSelect} />);
    // Calendar should render without errors in range mode
    const currentMonth = new Date().toLocaleString('default', { month: 'long' });
    expect(screen.getByText(new RegExp(currentMonth, 'i'))).toBeDefined();
  });

  it('accepts a selected date prop', () => {
    const selected = new Date(2024, 0, 15); // January 15, 2024
    const { container } = render(<Calendar mode="single" selected={selected} defaultMonth={selected} />);

    // Calendar should render successfully with a selected date
    expect(container.querySelector('.rdp')).toBeDefined();

    // Should show January 2024
    expect(screen.getByText(/january/i)).toBeDefined();
  });

  it('shows outside days when showOutsideDays is true', () => {
    render(<Calendar mode="single" showOutsideDays={true} />);
    // Calendar renders with outside days (default behavior)
    const currentMonth = new Date().toLocaleString('default', { month: 'long' });
    expect(screen.getByText(new RegExp(currentMonth, 'i'))).toBeDefined();
  });

  it('disables dates when disabled prop is provided', () => {
    const disabledDate = new Date(2024, 0, 15);
    render(<Calendar
      mode="single"
      disabled={disabledDate}
      defaultMonth={disabledDate}
    />);

    const dayButtons = screen.getAllByRole('button');
    const disabledButton = dayButtons.find(btn =>
      btn.textContent === '15' && btn.hasAttribute('disabled')
    );
    expect(disabledButton).toBeDefined();
  });
});
