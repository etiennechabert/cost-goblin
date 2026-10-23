import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RollupStats, RollupStatus } from '@costgoblin/core/browser';
import { RollupStatusButton } from '../renderer/top-menu/rollup-status-button.js';
import { fakeRollup } from './helpers/renderer-bridges.js';

const READY: RollupStatus = { state: 'ready', periods: 3 };
const STATS: RollupStats = { months: 3, rollupRows: 1500, rollupBytes: 2 * 1024 * 1024, rawBytes: 20 * 1024 * 1024 };

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Rollup status' });
}

/** The trigger's corner badge, or null when it shows none. */
function badge(): HTMLSpanElement | null {
  return trigger().querySelector('span');
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger());
  return screen.findByRole('dialog');
}

function deferredStats(): { promise: Promise<RollupStats | null>; resolve: (stats: RollupStats | null) => void } {
  let resolve: (stats: RollupStats | null) => void = () => undefined;
  const promise = new Promise<RollupStats | null>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('RollupStatusButton', () => {
  it.each<RollupStatus>([
    { state: 'computing', done: 2, total: 5, periods: [], active: [] },
    { state: 'failed', message: '1 of 4 partitions failed', reason: 'IO Error: disk full', periods: 3 },
    READY,
    { state: 'idle' },
  ])('explains itself on hover while $state, with no native title', async (status) => {
    const user = userEvent.setup();
    render(<RollupStatusButton status={status} />);
    expect(trigger().getAttribute('title')).toBeNull();
    await user.hover(trigger());
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Rollup')).toBeDefined();
    expect(within(tip).getByText('Pre-aggregated data for fast dashboards')).toBeDefined();
  });

  it('hides the tooltip while its popover is open, which still carries the status', async () => {
    const user = userEvent.setup();
    render(<RollupStatusButton status={{ state: 'failed', message: '1 of 4 partitions failed', reason: 'IO Error: disk full', periods: 3 }} />);
    await user.hover(trigger());
    const popover = await open(user);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(trigger());
    await user.hover(trigger());
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(within(popover).getByText(/1 of 4 partitions failed/)).toBeDefined();
    expect(popover.querySelector('[data-card-arrow]')).not.toBeNull();
  });

  it('flags a failed build with a badge', () => {
    render(<RollupStatusButton status={{ state: 'failed', message: 'failed', reason: 'boom', periods: 0 }} />);
    expect(badge()?.textContent).toBe('!');
  });

  it('pulses while a rebuild runs', () => {
    render(<RollupStatusButton status={{ state: 'computing', done: 1, total: 4, periods: [], active: [] }} />);
    const dot = badge();
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(dot?.textContent).toBe('');
  });

  it.each<RollupStatus>([READY, { state: 'idle' }])('shows no badge when the rollup is $state', (status) => {
    render(<RollupStatusButton status={status} />);
    expect(badge()).toBeNull();
  });

  it('loads the size figures when opened on a ready rollup', async () => {
    fakeRollup.stats = STATS;
    const getStats = vi.spyOn(fakeRollup, 'getStats');
    const user = userEvent.setup();
    render(<RollupStatusButton status={READY} />);
    expect(getStats).not.toHaveBeenCalled();

    const popover = await open(user);

    expect(getStats).toHaveBeenCalledOnce();
    expect(await within(popover).findByText('2 MB · 1.5K rows')).toBeDefined();
    expect(within(popover).getByText('Rollup size')).toBeDefined();
    expect(within(popover).getByText('Months built')).toBeDefined();
  });

  it('does not ask for size figures while the rollup is not ready', async () => {
    const getStats = vi.spyOn(fakeRollup, 'getStats');
    const user = userEvent.setup();
    render(<RollupStatusButton status={{ state: 'computing', done: 1, total: 4, periods: ['2026-01', '2026-02'], active: ['2026-02'] }} />);

    const popover = await open(user);

    expect(within(popover).getByText('1 / 4 months')).toBeDefined();
    expect(getStats).not.toHaveBeenCalled();
  });

  it('still shows the ready summary when the size figures cannot be read', async () => {
    const getStats = vi.spyOn(fakeRollup, 'getStats').mockRejectedValue(new Error('ENOENT'));
    const user = userEvent.setup();
    render(<RollupStatusButton status={READY} />);

    const popover = await open(user);

    await waitFor(() => { expect(getStats).toHaveBeenCalledOnce(); });
    expect(within(popover).getByText('Months built')).toBeDefined();
    expect(within(popover).queryByText('Rollup size')).toBeNull();
  });

  it('drops a size reply that arrives after the popover closed', async () => {
    const late = deferredStats();
    const fresh = deferredStats();
    vi.spyOn(fakeRollup, 'getStats')
      .mockReturnValueOnce(late.promise)
      .mockReturnValueOnce(fresh.promise);
    const user = userEvent.setup();
    render(<RollupStatusButton status={READY} />);

    await open(user);
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await act(async () => { late.resolve({ ...STATS, rollupRows: 999 }); await late.promise; });

    // Reopening asks again; the stale figures never show.
    const popover = await open(user);
    expect(within(popover).queryByText('Rollup size')).toBeNull();
    await act(async () => { fresh.resolve(STATS); await fresh.promise; });
    expect(await within(popover).findByText('2 MB · 1.5K rows')).toBeDefined();
    expect(within(popover).queryByText(/999 rows/)).toBeNull();
  });
});
