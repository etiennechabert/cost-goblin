import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { asDollars, asEntityRef } from '@costgoblin/core/browser';
import type { EntityRef, TrendRow } from '@costgoblin/core/browser';
import { BubbleChart } from '../components/bubble-chart.js';

function row(name: string, current: number, previous: number): TrendRow {
  const delta = current - previous;
  return {
    entity: asEntityRef(name),
    currentCost: asDollars(current),
    previousCost: asDollars(previous),
    delta: asDollars(delta),
    percentChange: (delta / previous) * 100,
  };
}

// EC2 grew (+$200, +25%), S3 shrank (−$100, −20%).
const TREND: readonly TrendRow[] = [row('EC2', 1_000, 800), row('S3', 400, 500)];

// Percent changes of 10%, 100% and 1000%: far apart on a linear axis,
// evenly spread on a log one.
const SPREAD: readonly TrendRow[] = [row('small', 110, 100), row('middle', 200, 100), row('huge', 1_100, 100)];

/** Bubbles render largest-cost first. */
async function bubbles(container: HTMLElement, count: number): Promise<Element[]> {
  await waitFor(() => { expect(container.querySelectorAll('circle')).toHaveLength(count); });
  return [...container.querySelectorAll('circle')];
}

function bubble(circles: readonly Element[], index: number): Element {
  const c = circles[index];
  if (c === undefined) throw new Error(`no bubble ${String(index)}`);
  return c;
}

/** Horizontal position of the "middle" bubble as a share of the plot width. */
async function middleShare(logScale: number | 'linear' | undefined): Promise<number> {
  const { container, unmount } = render(<BubbleChart data={SPREAD} logScale={logScale} onEntityClick={vi.fn()} />);
  const circles = await bubbles(container, 3);
  // Sorted by cost: huge, middle, small. 800px wide, 70 + 30 px margins.
  const share = Number(bubble(circles, 1).getAttribute('cx')) / (800 - 70 - 30);
  unmount();
  return share;
}

describe('BubbleChart', () => {
  it('shows a tooltip for the bubble under the pointer and reports each new hover once', async () => {
    const onEntityHover = vi.fn<(name: string | null) => void>();
    const { container } = render(<BubbleChart data={TREND} onEntityClick={vi.fn()} onEntityHover={onEntityHover} />);
    const circles = await bubbles(container, 2);
    const ec2 = bubble(circles, 0);

    fireEvent.mouseMove(ec2, { clientX: 300, clientY: 100 });
    expect(await screen.findByText('EC2')).toBeDefined();
    expect(screen.getByText('Current: $1.0k')).toBeDefined();
    const delta = screen.getByText('Delta: +$200.00');
    expect(delta.className).toContain('text-negative');
    expect(screen.getByText('Change: +25.0%').className).toContain('text-negative');
    expect(ec2.getAttribute('fill-opacity')).toBe('0.9');

    // Moving within the same bubble doesn't re-broadcast the hover.
    fireEvent.mouseMove(ec2, { clientX: 305, clientY: 102 });
    expect(onEntityHover.mock.calls).toEqual([[asEntityRef('EC2')]]);

    fireEvent.mouseMove(bubble(circles, 1), { clientX: 200, clientY: 300 });
    expect(onEntityHover).toHaveBeenLastCalledWith(asEntityRef('S3'));
    const saving = screen.getByText(/^Delta:/);
    expect(saving.textContent).toMatch(/^Delta: .*100\.00$/);
    expect(saving.textContent).not.toContain('+');
    expect(saving.className).toContain('text-positive');
    expect(screen.getByText('Change: -20.0%').className).toContain('text-positive');

    fireEvent.mouseLeave(bubble(circles, 1));
    await waitFor(() => { expect(screen.queryByText('Change: -20.0%')).toBeNull(); });
    expect(onEntityHover).toHaveBeenLastCalledWith(null);

    // A second leave (e.g. from the chart frame) has nothing left to clear.
    const calls = onEntityHover.mock.calls.length;
    const frame = container.querySelector('.relative');
    if (frame === null) throw new Error('no chart frame');
    fireEvent.mouseLeave(frame);
    expect(onEntityHover).toHaveBeenCalledTimes(calls);
  });

  it('tracks hover locally when no one listens for it', async () => {
    const { container } = render(<BubbleChart data={TREND} onEntityClick={vi.fn()} />);
    const circles = await bubbles(container, 2);

    fireEvent.mouseMove(bubble(circles, 1), { clientX: 200, clientY: 300 });
    expect(bubble(circles, 1).getAttribute('fill-opacity')).toBe('0.9');
    fireEvent.mouseLeave(bubble(circles, 1));
    expect(bubble(circles, 1).getAttribute('fill-opacity')).toBe('0.6');
  });

  it('emphasises the bubble hovered in another chart', async () => {
    const onEntityClick = vi.fn<(entity: EntityRef) => void>();
    const { container } = render(<BubbleChart data={TREND} onEntityClick={onEntityClick} externalHoveredName="S3" />);
    const circles = await bubbles(container, 2);

    expect(bubble(circles, 1).getAttribute('fill-opacity')).toBe('0.9');
    expect(bubble(circles, 1).getAttribute('stroke')).toBe('var(--color-text-primary)');
    expect(bubble(circles, 0).getAttribute('fill-opacity')).toBe('0.6');
    expect(bubble(circles, 0).getAttribute('stroke')).toBe('none');
  });

  it('spreads changes linearly or logarithmically depending on the scale', async () => {
    const linear = await middleShare('linear');
    const log10 = await middleShare(10);
    const byDefault = await middleShare(undefined);
    const log2 = await middleShare(2);

    // On a linear axis a +100% change sits near the left, dwarfed by +1000%;
    // a log axis pulls it towards the middle, more so the smaller the base.
    expect(linear).toBeLessThan(0.3);
    expect(log10).toBeGreaterThan(0.5);
    expect(byDefault).toBeCloseTo(log10, 6);
    expect(log2).toBeGreaterThan(log10);
  });

  it('clears the plot when the data empties', async () => {
    const onEntityClick = vi.fn<(entity: EntityRef) => void>();
    const { container, rerender } = render(<BubbleChart data={TREND} onEntityClick={onEntityClick} />);
    await bubbles(container, 2);

    rerender(<BubbleChart data={[]} onEntityClick={onEntityClick} />);

    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('circle')).toBeNull();
  });
});
