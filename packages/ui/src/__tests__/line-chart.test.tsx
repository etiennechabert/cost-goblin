import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LineChart } from '../components/line-chart.js';
import type { LineSeries } from '../components/line-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';

const SERIES: readonly LineSeries[] = [
  { name: 'EC2', points: [{ date: '2026-01-01', cost: 100 }, { date: '2026-01-02', cost: 150 }, { date: '2026-01-03', cost: 120 }] },
  { name: 'S3', points: [{ date: '2026-01-01', cost: 50 }, { date: '2026-01-02', cost: 60 }, { date: '2026-01-03', cost: 70 }] },
  // Sparse: no point on Jan 2.
  { name: 'RDS', points: [{ date: '2026-01-01', cost: 30 }, { date: '2026-01-03', cost: 40 }] },
];

// The mocked container is 800px wide: the plot starts 60px in and spans
// 800 − 60 − 24 = 716px, Jan 1 → Jan 3.
const PLOT_LEFT = 60;
const PLOT_WIDTH = 716;

function renderLine(ui: React.ReactElement) {
  return render(<PaletteProvider>{ui}</PaletteProvider>);
}

async function overlay(container: HTMLElement): Promise<Element> {
  await waitFor(() => { expect(container.querySelector('rect[fill="transparent"]')).not.toBeNull(); });
  const rect = container.querySelector('rect[fill="transparent"]');
  if (rect === null) throw new Error('no hover overlay');
  return rect;
}

/** The open tooltip, once the hover has rendered it. */
async function tooltip(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => { expect(container.querySelector('.visx-tooltip')).not.toBeNull(); });
  const tip = container.querySelector('.visx-tooltip');
  if (!(tip instanceof HTMLElement)) throw new Error('no tooltip');
  return tip;
}

function yTicks(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.visx-axis-left .visx-axis-tick text')].map(t => t.textContent);
}

function linePaths(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('path.visx-linepath')];
}

describe('LineChart — hover tooltip', () => {
  it('shows every visible series’ cost at the date nearest the pointer', async () => {
    const { container } = renderLine(<LineChart series={SERIES} />);
    const rect = await overlay(container);

    // Halfway across the plot is Jan 2.
    fireEvent.mouseMove(rect, { clientX: PLOT_LEFT + PLOT_WIDTH / 2, clientY: 100 });

    let tip = await tooltip(container);
    expect(within(tip).getByText('2026-01-02')).toBeDefined();
    expect(within(tip).getByText('$150.00')).toBeDefined();
    expect(within(tip).getByText('$60.00')).toBeDefined();
    // RDS has no point that day, so it is left out rather than shown as $0.
    expect(within(tip).queryByText('RDS')).toBeNull();

    // Snap to the nearest date: just right of the left edge is Jan 1.
    fireEvent.mouseMove(rect, { clientX: PLOT_LEFT + 20, clientY: 100 });
    await waitFor(() => { expect(container.querySelector('.visx-tooltip')?.textContent).toContain('2026-01-01'); });
    tip = await tooltip(container);
    expect(within(tip).getByText('RDS')).toBeDefined();
    expect(within(tip).getByText('$30.00')).toBeDefined();

    fireEvent.mouseLeave(rect);
    await waitFor(() => { expect(container.querySelector('.visx-tooltip')).toBeNull(); });
  });

  it('ignores the pointer outside the plot area', async () => {
    const { container } = renderLine(<LineChart series={SERIES} />);
    const rect = await overlay(container);

    fireEvent.mouseMove(rect, { clientX: PLOT_LEFT - 5, clientY: 100 });
    fireEvent.mouseMove(rect, { clientX: PLOT_LEFT + PLOT_WIDTH + 5, clientY: 100 });
    expect(container.querySelector('.visx-tooltip')).toBeNull();

    // The same overlay does respond inside the plot.
    fireEvent.mouseMove(rect, { clientX: PLOT_LEFT + PLOT_WIDTH, clientY: 100 });
    expect(within(await tooltip(container)).getByText('2026-01-03')).toBeDefined();
  });

  it('leaves hidden series out of the tooltip', async () => {
    const user = userEvent.setup();
    const { container } = renderLine(<LineChart series={SERIES} />);
    const rect = await overlay(container);

    await user.click(screen.getByRole('button', { name: 'S3' }));
    fireEvent.mouseMove(rect, { clientX: PLOT_LEFT + PLOT_WIDTH / 2, clientY: 100 });

    const tip = await tooltip(container);
    expect(within(tip).getByText('$150.00')).toBeDefined();
    expect(within(tip).queryByText('S3')).toBeNull();
  });

  it('draws an empty plot, with no tooltip, when there are no points', async () => {
    const { container } = renderLine(<LineChart series={[{ name: 'Idle', points: [] }]} title="Nothing yet" />);
    const rect = await overlay(container);

    fireEvent.mouseMove(rect, { clientX: PLOT_LEFT + 100, clientY: 100 });

    expect(container.querySelector('.visx-tooltip')).toBeNull();
    // With no costs the y axis still spans $0 → $1 rather than collapsing.
    const ticks = yTicks(container);
    expect(ticks[0]).toBe('$0.00');
    expect(ticks.at(-1)).toBe('$1.00');
    expect(screen.getByText('Nothing yet')).toBeDefined();
  });
});

describe('LineChart — legend', () => {
  it('hides and re-shows a series on double-click even when clicks filter', async () => {
    const user = userEvent.setup();
    const onSeriesClick = vi.fn<(name: string) => void>();
    const { container } = renderLine(<LineChart series={SERIES} onSeriesClick={onSeriesClick} />);
    await waitFor(() => { expect(linePaths(container)).toHaveLength(3); });

    const ec2 = screen.getByRole('button', { name: 'EC2' });
    expect(ec2.getAttribute('title')).toBe('Click to filter, double-click to hide');

    await user.dblClick(ec2);
    await waitFor(() => { expect(linePaths(container)).toHaveLength(2); });
    expect(ec2.style.opacity).toBe('0.4');
    expect(ec2.getAttribute('title')).toBe('Show series');

    await user.dblClick(ec2);
    await waitFor(() => { expect(linePaths(container)).toHaveLength(3); });
    expect(ec2.style.opacity).toBe('1');
    // Each click of the double-click also filtered.
    expect(onSeriesClick).toHaveBeenCalledWith('EC2');
  });

  it('hides a series’ previous-period ghost line along with it', async () => {
    const user = userEvent.setup();
    const previous: readonly LineSeries[] = [
      { name: 'EC2', points: [{ date: '2026-01-01', cost: 90 }, { date: '2026-01-03', cost: 400 }] },
      // A previous-period series with no current counterpart still draws.
      { name: 'Retired', points: [{ date: '2026-01-01', cost: 10 }] },
    ];
    const { container } = renderLine(<LineChart series={SERIES} previousSeries={previous} subtitle="Top 3" />);
    await waitFor(() => { expect(linePaths(container)).toHaveLength(5); });

    expect(screen.getByText('Top 3')).toBeDefined();
    expect(container.querySelector('h3')).toBeNull();
    // The ghost line's $400 peak stretches the y axis beyond the current max.
    expect(yTicks(container)).toContain('$400.00');

    await user.click(screen.getByRole('button', { name: 'EC2' }));
    await waitFor(() => { expect(linePaths(container)).toHaveLength(3); });
    expect(container.querySelectorAll('path.visx-linepath[stroke-dasharray]')).toHaveLength(1);
  });

  it('renders no header without a title or subtitle', async () => {
    const { container } = renderLine(<LineChart series={SERIES} height={200} />);
    await waitFor(() => { expect(linePaths(container)).toHaveLength(3); });

    expect(container.querySelector('h3')).toBeNull();
    const frame = container.querySelector('.rounded-xl');
    expect(frame instanceof HTMLElement ? frame.style.height : null).toBe('200px');
  });
});
