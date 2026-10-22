import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { StackedBarChart, bucketBars } from '../components/stacked-bar-chart.js';
import type { BarDay, HistogramTab } from '../components/stacked-bar-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';

// Four days. Day 2 is the peak and adds RDS (absent the day before); day 3
// drops EC2 to zero and S3 by 40%; day 4 has no spend at all.
const DAYS: readonly BarDay[] = [
  { date: '2026-03-01', total: 100, breakdown: { EC2: 60, S3: 40 } },
  { date: '2026-03-02', total: 210, breakdown: { EC2: 150, S3: 50, RDS: 10 } },
  { date: '2026-03-03', total: 50, breakdown: { EC2: 0, S3: 30, RDS: 20 } },
  { date: '2026-03-04', total: 0, breakdown: {} },
];

function renderChart(ui: React.ReactElement) {
  return render(<PaletteProvider>{ui}</PaletteProvider>);
}

/** One column per bar, in date order. */
function columns(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('.group.relative')].filter((el): el is HTMLElement => el instanceof HTMLElement);
}

function column(container: HTMLElement, index: number): HTMLElement {
  const col = columns(container)[index];
  if (col === undefined) throw new Error(`no bar ${String(index)}`);
  return col;
}

/** The stacked segments of a bar, largest first. */
function segments(col: HTMLElement): HTMLElement[] {
  const stack = col.firstElementChild;
  if (stack === null) throw new Error('bar has no stack');
  return [...stack.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
}

function segment(col: HTMLElement, index: number): HTMLElement {
  const seg = segments(col)[index];
  if (seg === undefined) throw new Error(`no segment ${String(index)}`);
  return seg;
}

/** The floating day tooltip, or null when none is open. */
function tooltip(): HTMLElement | null {
  // The day's total comes first; a previous-period total may follow it.
  const total = screen.queryAllByText(/^Total:/)[0];
  return total?.closest('.min-w-\\[280px\\]') ?? null;
}

function openTooltip(): HTMLElement {
  const tip = tooltip();
  if (!(tip instanceof HTMLElement)) throw new Error('no tooltip open');
  return tip;
}

/** The tooltip rows as "name value (pct)" text, in display order. */
function tooltipRows(): string[] {
  return [...openTooltip().querySelectorAll('.pointer-events-auto')].map(r => r.textContent);
}

/** The previous-period overlay's vertices. */
function polylinePoints(container: HTMLElement): [number, number][] {
  const attr = container.querySelector('polyline')?.getAttribute('points') ?? '';
  return attr.split(' ').filter(p => p.length > 0).map((pair): [number, number] => {
    const [x, y] = pair.split(',').map(Number);
    return [x ?? Number.NaN, y ?? Number.NaN];
  });
}

function barsArea(container: HTMLElement): HTMLElement {
  const area = container.querySelector('.items-end.z-10');
  if (!(area instanceof HTMLElement)) throw new Error('no bars area');
  return area;
}

describe('bucketBars', () => {
  it('returns short series untouched', () => {
    expect(bucketBars(DAYS, 10)).toBe(DAYS);
  });

  it('merges consecutive bars into buckets dated by their first day', () => {
    const bars: BarDay[] = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, '0')}`,
      total: i + 1,
      breakdown: i % 2 === 0 ? { a: i + 1 } : { b: i + 1 },
    }));

    // ceil(10 / 4) = 3 bars per bucket: [1..3] [4..6] [7..9] [10].
    expect(bucketBars(bars, 4)).toEqual([
      { date: '2026-03-01', total: 6, breakdown: { a: 4, b: 2 } },
      { date: '2026-03-04', total: 15, breakdown: { a: 5, b: 10 } },
      { date: '2026-03-07', total: 24, breakdown: { a: 16, b: 8 } },
      { date: '2026-03-10', total: 10, breakdown: { b: 10 } },
    ]);
  });
});

describe('StackedBarChart — layout', () => {
  it('scales bars to the peak day and labels both axes', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS} />);

    expect(screen.getByText('Daily Costs')).toBeDefined();
    for (const label of ['$210.00', '$157.50', '$105.00', '$52.50', '$0.00']) {
      expect(screen.getByText(label)).toBeDefined();
    }

    const heights = columns(container).map(c => c.firstElementChild instanceof HTMLElement ? c.firstElementChild.style.height : '');
    expect(heights[1]).toBe('100%');
    expect(heights[3]).toBe('0%');
    // Zero-value segments are not drawn.
    expect(segments(column(container, 2))).toHaveLength(2);
    expect(segments(column(container, 1))).toHaveLength(3);

    // The first tick hugs the left edge, the last the right, the rest centre.
    expect(screen.getByText('03-01').className).not.toContain('translate-x');
    expect(screen.getByText('03-02').className).toContain('-translate-x-1/2');
    expect(screen.getByText('03-04').className).toContain('-translate-x-full');
    // Short series get the wider bar gap.
    expect(barsArea(container).style.gap).toBe('2px');
  });

  it('labels the axis, the tooltip and the drag edges by period for weekly and monthly bars', () => {
    const months: readonly BarDay[] = [
      { date: '2026-08-01', total: 10, breakdown: { EC2: 10 } },
      { date: '2026-09-01', total: 20, breakdown: { EC2: 20 } },
      { date: '2026-10-01', total: 0, breakdown: {} },
    ];
    const { container, rerender } = renderChart(<StackedBarChart days={months} granularity="monthly" onRangeSelect={vi.fn()} />);

    for (const label of ['Aug 2026', 'Sep 2026', 'Oct 2026']) expect(screen.getByText(label)).toBeDefined();
    fireEvent.mouseEnter(column(container, 1));
    expect(within(openTooltip()).getByText('Sep 2026')).toBeDefined();
    fireEvent.mouseLeave(column(container, 1));

    rerender(
      <PaletteProvider>
        <StackedBarChart
          days={[{ date: '2026-10-19', total: 5, breakdown: { EC2: 5 } }, { date: '2026-10-26', total: 5, breakdown: { EC2: 5 } }]}
          granularity="weekly"
        />
      </PaletteProvider>,
    );
    expect(screen.getByText('W43 2026')).toBeDefined();
    expect(screen.getByText('W44 2026')).toBeDefined();
  });

  it('thins the gap and the date ticks for long series', () => {
    const many: BarDay[] = Array.from({ length: 120 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      return { date: d, total: 10, breakdown: { a: 10 } };
    });
    const { container } = renderChart(<StackedBarChart days={many} title="Quarter" />);

    expect(screen.getByText('Quarter')).toBeDefined();
    expect(barsArea(container).style.gap).toBe('1px');
    // ceil(120 / 7) = 18 bars between ticks.
    expect(container.querySelectorAll('.bottom-0.left-12 span')).toHaveLength(7);
  });

  it('shows a loader while loading and an empty state once loaded', () => {
    const { rerender } = renderChart(<StackedBarChart days={[]} loading />);
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.queryByText('No daily data')).toBeNull();

    rerender(<PaletteProvider><StackedBarChart days={[]} loading expanded /></PaletteProvider>);
    expect(screen.getByRole('status').style.height).toBe('340px');

    rerender(<PaletteProvider><StackedBarChart days={[]} /></PaletteProvider>);
    expect(screen.getByText('No daily data')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('switches histogram tabs', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn<(tab: HistogramTab) => void>();
    renderChart(<StackedBarChart days={DAYS} tab="service" onTabChange={onTabChange} />);

    expect(screen.getByRole('button', { name: 'Services' }).className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Groups' }).className).not.toContain('bg-accent');

    await user.click(screen.getByRole('button', { name: 'Products' }));
    expect(onTabChange).toHaveBeenCalledWith('product');
  });

  it('has no tabs without a change handler', () => {
    renderChart(<StackedBarChart days={DAYS} tab="service" />);
    expect(screen.queryByRole('button', { name: 'Services' })).toBeNull();
  });

  it('toggles expansion and grows when expanded', async () => {
    const user = userEvent.setup();
    const onExpandToggle = vi.fn<() => void>();
    const { container, rerender } = renderChart(<StackedBarChart days={DAYS} onExpandToggle={onExpandToggle} />);

    await user.click(screen.getByTitle('Expand'));
    expect(onExpandToggle).toHaveBeenCalledTimes(1);
    const area = () => container.querySelector('.relative.flex-1');
    expect(area() instanceof HTMLElement ? area()?.getAttribute('style') : null).toContain('min-height: 180px');

    rerender(<PaletteProvider><StackedBarChart days={DAYS} expanded onExpandToggle={onExpandToggle} /></PaletteProvider>);
    expect(screen.getByTitle('Collapse')).toBeDefined();
    expect(area()?.getAttribute('style')).toContain('min-height: 360px');
  });
});

describe('StackedBarChart — day tooltip', () => {
  it('breaks the hovered day down, largest first, with day-over-day deltas', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS} />);

    fireEvent.mouseEnter(column(container, 1));

    const tip = openTooltip();
    expect(within(tip).getByText('2026-03-02')).toBeDefined();
    expect(within(tip).getByText(/^Total:/).textContent).toBe('Total: $210.00↑110.0%');
    expect(within(tip).getByText('↑110.0%').className).toContain('text-negative');
    // RDS is new today, so it has no delta against yesterday.
    expect(tooltipRows()).toEqual([
      'EC2$150.00 (71.4%)↑150.0%',
      'S3$50.00 (23.8%)↑25.0%',
      'RDS$10.00 (4.8%)',
    ]);
    // An early bar opens its tooltip on the far side.
    expect(tip.parentElement?.className).toContain('right-0');
    expect(within(tip).queryByText('Previous period')).toBeNull();
  });

  it('shows a drop in green and opens late tooltips on the left', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS} />);

    fireEvent.mouseEnter(column(container, 2));

    const tip = openTooltip();
    expect(within(tip).getByText('↓76.2%').className).toContain('text-positive');
    expect(tooltipRows()).toEqual(['S3$30.00 (60.0%)↓40.0%', 'RDS$20.00 (40.0%)↑100.0%']);
    expect(within(tip).getByText('↓40.0%').className).toContain('text-positive');
    expect(within(tip).getByText('↑100.0%').className).toContain('text-negative');
    expect(tip.parentElement?.className).toContain('left-12');
  });

  it('has no deltas on the first day, and closes when the pointer leaves', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS} />);

    fireEvent.mouseEnter(column(container, 0));
    expect(within(openTooltip()).getByText(/^Total:/).textContent).toBe('Total: $100.00');
    expect(tooltipRows()).toEqual(['EC2$60.00 (60.0%)', 'S3$40.00 (40.0%)']);

    const chartArea = container.querySelector('.relative.flex-1');
    if (chartArea === null) throw new Error('no chart area');
    fireEvent.mouseLeave(chartArea);
    expect(tooltip()).toBeNull();
  });

  it('drops the tooltip when the hovered day leaves the data', () => {
    const { container, rerender } = renderChart(<StackedBarChart days={DAYS} />);
    fireEvent.mouseEnter(column(container, 3));
    expect(tooltip()).not.toBeNull();

    // A refresh (new range) no longer contains the hovered date.
    rerender(<PaletteProvider><StackedBarChart days={DAYS.slice(0, 2)} /></PaletteProvider>);
    expect(tooltip()).toBeNull();
  });

  it('compares against the previous period when it is supplied', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS} previousTotals={[80, 0, 100, 10]} />);

    fireEvent.mouseEnter(column(container, 0));
    let tip = openTooltip();
    expect(within(tip).getAllByText(/^Total:/).map(t => t.textContent)).toEqual(['Total: $100.00↑25.0%', 'Total: $80.00']);
    expect(within(tip).getByText('Previous period')).toBeDefined();

    // A zero previous total gives no ratio and no previous-period line.
    fireEvent.mouseEnter(column(container, 1));
    tip = openTooltip();
    expect(within(tip).getByText(/^Total:/).textContent).toBe('Total: $210.00');
    expect(within(tip).queryByText('Previous period')).toBeNull();

    // The previous period is drawn as a dashed line over the bars, on the
    // same $210 scale (viewBox units: x across 0–1000, y down from the top).
    const expected: readonly (readonly [number, number])[] = [[0, 619.05], [333.33, 1000], [666.67, 523.81], [1000, 952.38]];
    const points = polylinePoints(container);
    expect(points).toHaveLength(expected.length);
    points.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(expected[i]?.[0] ?? Number.NaN, 1);
      expect(y).toBeCloseTo(expected[i]?.[1] ?? Number.NaN, 1);
    });
  });

  it('draws a lone previous-period point at the centre', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS.slice(0, 1)} previousTotals={[50]} />);
    expect(polylinePoints(container)).toEqual([[500, 500]]);
  });

  it('skips the previous-period line when there is nothing to scale it by', () => {
    const { container, rerender } = renderChart(<StackedBarChart days={DAYS} previousTotals={[]} />);
    expect(container.querySelector('polyline')).toBeNull();

    const zero: BarDay[] = [{ date: '2026-03-01', total: 0, breakdown: {} }];
    rerender(<PaletteProvider><StackedBarChart days={zero} previousTotals={[0]} /></PaletteProvider>);
    expect(container.querySelector('polyline')).toBeNull();
  });
});

describe('StackedBarChart — series focus', () => {
  it('highlights the hovered segment in the tooltip and reports it', () => {
    const onSegmentHover = vi.fn<(name: string | null) => void>();
    const { container } = renderChart(<StackedBarChart days={DAYS} onSegmentHover={onSegmentHover} />);
    const day2 = column(container, 1);

    // Segments stack largest first: EC2, S3, RDS.
    fireEvent.mouseEnter(segment(day2, 1));
    expect(onSegmentHover).toHaveBeenLastCalledWith('S3');
    const s3Row = within(openTooltip()).getByText('S3').closest('.pointer-events-auto');
    expect(s3Row?.className).toContain('bg-white/10');
    // The other series fade, the focused one is outlined.
    expect(segment(day2, 0).style.opacity).toBe('0.25');
    expect(segment(day2, 1).style.opacity).toBe('1');
    expect(segment(day2, 1).style.boxShadow).toContain('inset');

    // Pointing at a tooltip row moves the focus too.
    const ec2Row = within(openTooltip()).getByText('EC2').closest('.pointer-events-auto');
    if (ec2Row === null) throw new Error('no EC2 row');
    fireEvent.mouseEnter(ec2Row);
    expect(onSegmentHover).toHaveBeenLastCalledWith('EC2');
    fireEvent.mouseLeave(ec2Row);
    expect(onSegmentHover).toHaveBeenLastCalledWith(null);
    expect(segment(day2, 0).style.opacity).toBe('0.85');
  });

  it('dims everything but the series focused in another chart', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS} highlightedGroup="EC2" />);
    const day1 = column(container, 0);

    expect(segment(day1, 0).style.opacity).toBe('1');
    expect(segment(day1, 0).style.filter).toBe('brightness(1.2)');
    expect(segment(day1, 1).style.opacity).toBe('0.25');

    fireEvent.mouseEnter(day1);
    const ec2Row = within(openTooltip()).getByText('EC2').closest('.pointer-events-auto');
    expect(ec2Row?.className).toContain('bg-white/10');
  });

  it('filters on a segment click, Enter or Space', () => {
    const onSegmentClick = vi.fn<(name: string) => void>();
    const { container } = renderChart(<StackedBarChart days={DAYS} onSegmentClick={onSegmentClick} />);
    const day2 = column(container, 1);

    expect(segment(day2, 0).tagName).toBe('BUTTON');
    fireEvent.click(segment(day2, 0));
    fireEvent.keyDown(segment(day2, 1), { key: 'Enter' });
    fireEvent.keyDown(segment(day2, 2), { key: ' ' });
    fireEvent.keyDown(segment(day2, 2), { key: 'Escape' });

    expect(onSegmentClick.mock.calls).toEqual([['EC2'], ['S3'], ['RDS']]);
  });

  it('draws plain segments when nothing filters', () => {
    const { container } = renderChart(<StackedBarChart days={DAYS} />);
    expect(segment(column(container, 0), 0).tagName).toBe('DIV');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('StackedBarChart — drag to zoom', () => {
  /** Pin a 400px-wide bars area (100px per bar) and drag across it. */
  function drag(container: HTMLElement, fromX: number, toX: number, release = true): void {
    const area = barsArea(container);
    area.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
    fireEvent.mouseDown(area, { clientX: fromX, clientY: 50, button: 0 });
    fireEvent.mouseMove(window, { clientX: toX, clientY: 50 });
    if (release) fireEvent.mouseUp(window);
  }

  it('labels the dragged span live and reports the selected bars', () => {
    const onRangeSelect = vi.fn<(startIdx: number, endIdx: number) => void>();
    const { container } = renderChart(<StackedBarChart days={DAYS} onRangeSelect={onRangeSelect} />);

    const area = barsArea(container);
    expect(area.getAttribute('role')).toBe('button');
    expect(area.className).toContain('cursor-crosshair');

    fireEvent.mouseEnter(column(container, 1));
    expect(tooltip()).not.toBeNull();

    drag(container, 110, 390, false);
    // The edge labels name the first and last bar under the overlay, and the
    // day tooltip gets out of the way while dragging.
    expect(screen.getByText('Mar 2')).toBeDefined();
    expect(screen.getByText('Mar 4')).toBeDefined();
    expect(tooltip()).toBeNull();

    fireEvent.mouseUp(window);
    expect(onRangeSelect).toHaveBeenCalledWith(1, 3);
    expect(screen.queryByText('Mar 2')).toBeNull();
  });

  it('is not draggable while loading or without a handler', () => {
    const onRangeSelect = vi.fn<(startIdx: number, endIdx: number) => void>();
    const { container, rerender } = renderChart(<StackedBarChart days={DAYS} onRangeSelect={onRangeSelect} loading />);

    drag(container, 10, 390);
    expect(onRangeSelect).not.toHaveBeenCalled();

    rerender(<PaletteProvider><StackedBarChart days={DAYS} /></PaletteProvider>);
    expect(barsArea(container).getAttribute('role')).toBeNull();
    expect(barsArea(container).className).not.toContain('cursor-crosshair');
  });
});
