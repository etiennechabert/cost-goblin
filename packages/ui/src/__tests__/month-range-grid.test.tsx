import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDateString } from '@costgoblin/core/browser';
import { MonthRangeGrid } from '../components/month-range-grid.js';

const NEWEST = asDateString('2026-10-19');
const VALUE = { start: asDateString('2026-08-01'), end: asDateString('2026-10-31') };

function renderGrid() {
  const onSelect = vi.fn();
  render(<MonthRangeGrid value={VALUE} newestDay={NEWEST} onSelect={onSelect} />);
  return { onSelect, user: userEvent.setup() };
}

afterEach(cleanup);

describe('MonthRangeGrid', () => {
  it('shows the twelve months of the year holding the range end', () => {
    renderGrid();
    expect(screen.getByText('2026')).toBeDefined();
    for (const month of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']) {
      expect(screen.getByRole('button', { name: month })).toBeDefined();
    }
  });

  it('commits whole months after a start and an end click', async () => {
    const { onSelect, user } = renderGrid();
    await user.click(screen.getByRole('button', { name: 'Mar' }));
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Oct' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith({ start: '2026-03-01', end: '2026-10-31' });
  });

  it('gives the same range when the later month is clicked first', async () => {
    const { onSelect, user } = renderGrid();
    await user.click(screen.getByRole('button', { name: 'Oct' }));
    await user.click(screen.getByRole('button', { name: 'Mar' }));
    expect(onSelect).toHaveBeenCalledWith({ start: '2026-03-01', end: '2026-10-31' });
  });

  it('commits a single month when the same month is clicked twice', async () => {
    const { onSelect, user } = renderGrid();
    await user.click(screen.getByRole('button', { name: 'Feb' }));
    await user.click(screen.getByRole('button', { name: 'Feb' }));
    expect(onSelect).toHaveBeenCalledWith({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('disables the months after the newest available day', () => {
    renderGrid();
    expect(screen.getByRole('button', { name: 'Oct' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Nov' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Dec' }).hasAttribute('disabled')).toBe(true);
  });

  it('pages between years and spans them in one selection', async () => {
    const { onSelect, user } = renderGrid();
    expect(screen.getByRole('button', { name: 'Next year' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Previous year' }));
    expect(screen.getByText('2025')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dec' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Nov' }));
    await user.click(screen.getByRole('button', { name: 'Next year' }));
    await user.click(screen.getByRole('button', { name: 'Feb' }));
    expect(onSelect).toHaveBeenCalledWith({ start: '2025-11-01', end: '2026-02-28' });
  });

  it('marks the months of the committed range as selected', () => {
    renderGrid();
    expect(screen.getByRole('button', { name: 'Aug' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Oct' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Jul' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('marks only the start month while the end is still to be picked', async () => {
    const { user } = renderGrid();
    await user.click(screen.getByRole('button', { name: 'Mar' }));
    expect(screen.getByRole('button', { name: 'Mar' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Aug' }).getAttribute('aria-pressed')).toBe('false');
  });
});
