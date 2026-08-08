import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDollars, asEntityRef } from '@costgoblin/core/browser';
import type { TrendRow } from '@costgoblin/core/browser';
import { PieChart } from '../components/pie-chart.js';
import { LineChart } from '../components/line-chart.js';
import { BubbleChart } from '../components/bubble-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';

// Direct render-output tests for the chart bodies. The mocked ResizeObserver
// (setup.ts) reports a real container size, so the SVG internals — normally
// gated behind a measured width — actually mount in jsdom and we can assert
// marks and labels produced from fixture data.

function renderChart(ui: React.ReactElement) {
  return render(<PaletteProvider>{ui}</PaletteProvider>);
}

describe('PieChart render output', () => {
  const SLICES = [
    { name: 'EC2', cost: 500, percentage: 50 },
    { name: 'S3', cost: 300, percentage: 30 },
    { name: 'RDS', cost: 200, percentage: 20 },
  ];

  it('renders a slice path and a legend entry per datum', async () => {
    const { container } = renderChart(<PieChart data={SLICES} title="By service" />);

    expect(await screen.findByText('EC2')).toBeDefined();
    expect(screen.getByText('By service')).toBeDefined();
    expect(screen.getByText('S3')).toBeDefined();
    expect(screen.getByText('RDS')).toBeDefined();
    expect(screen.getByText('$500.00 (50.0%)')).toBeDefined();
    expect(screen.getByText('$300.00 (30.0%)')).toBeDefined();
    expect(screen.getByText('$200.00 (20.0%)')).toBeDefined();

    const paths = container.querySelectorAll('svg path');
    expect(paths).toHaveLength(3);
    for (const path of paths) {
      expect(path.getAttribute('d')).toMatch(/^M/);
    }
  });

  it('folds the tail into an inert Other slice and reports legend clicks', async () => {
    const user = userEvent.setup();
    const onSliceClick = vi.fn();
    renderChart(
      <PieChart data={SLICES} title="By service" maxSlices={2} onSliceClick={onSliceClick} />,
    );

    expect(await screen.findByText('Other')).toBeDefined();
    expect(screen.queryByText('RDS')).toBeNull();
    // Other carries the folded tail's cost and share (RDS only here).
    expect(screen.getByText('$200.00 (20.0%)')).toBeDefined();
    // Other is not clickable — it is not a real slice.
    expect(screen.getByText('Other').closest('button')).toBeNull();

    // Click the legend button, not the inner text span: hovering swaps the
    // entry into its expanded layout, so inner nodes are replaced mid-click.
    await user.click(screen.getByRole('button', { name: /EC2/ }));
    expect(onSliceClick).toHaveBeenCalledWith('EC2');
  });
});

describe('LineChart render output', () => {
  const SERIES = [
    {
      name: 'EC2',
      points: [
        { date: '2026-01-01', cost: 100 },
        { date: '2026-01-02', cost: 150 },
        { date: '2026-01-03', cost: 120 },
      ],
    },
    {
      name: 'S3',
      points: [
        { date: '2026-01-01', cost: 50 },
        { date: '2026-01-02', cost: 60 },
        { date: '2026-01-03', cost: 70 },
      ],
    },
  ];

  it('draws one line per series with dollar and date axes', async () => {
    const { container } = renderChart(<LineChart series={SERIES} title="Daily cost" />);

    await waitFor(() => {
      expect(container.querySelectorAll('path.visx-linepath')).toHaveLength(2);
    });
    for (const path of container.querySelectorAll('path.visx-linepath')) {
      expect(path.getAttribute('d')).toMatch(/^M/);
    }
    // y axis is formatted as dollars; the domain always starts at $0.
    expect(screen.getByText('$0.00')).toBeDefined();
    // x axis renders date tick labels.
    expect(container.querySelectorAll('.visx-axis-bottom text').length).toBeGreaterThan(0);
  });

  it('overlays dashed ghost lines for the previous period', async () => {
    const previous = [
      {
        name: 'EC2',
        points: [
          { date: '2026-01-01', cost: 90 },
          { date: '2026-01-02', cost: 95 },
          { date: '2026-01-03', cost: 100 },
        ],
      },
    ];
    const { container } = renderChart(
      <LineChart series={SERIES} previousSeries={previous} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('path.visx-linepath')).toHaveLength(3);
    });
    expect(
      container.querySelectorAll('path.visx-linepath[stroke-dasharray="4,3"]'),
    ).toHaveLength(1);
  });

  it('toggles a series from the legend when no click handler is set', async () => {
    const user = userEvent.setup();
    const { container } = renderChart(<LineChart series={SERIES} />);

    await waitFor(() => {
      expect(container.querySelectorAll('path.visx-linepath')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'EC2' }));
    await waitFor(() => {
      expect(container.querySelectorAll('path.visx-linepath')).toHaveLength(1);
    });
  });

  it('routes legend clicks to onSeriesClick when provided', async () => {
    const user = userEvent.setup();
    const onSeriesClick = vi.fn();
    const { container } = renderChart(
      <LineChart series={SERIES} onSeriesClick={onSeriesClick} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('path.visx-linepath')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'S3' }));
    expect(onSeriesClick).toHaveBeenCalledWith('S3');
    // Filtering, not hiding: both lines stay.
    expect(container.querySelectorAll('path.visx-linepath')).toHaveLength(2);
  });
});

describe('BubbleChart render output', () => {
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
  const TREND = [row('EC2', 1000, 800), row('S3', 400, 500)];

  it('plots one bubble per entity, sized by cost and colored by direction', async () => {
    const { container } = renderChart(<BubbleChart data={TREND} onEntityClick={vi.fn()} />);

    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(2);
    });
    // Bubbles draw in descending cost order, so EC2 (the increase) is first.
    const [ec2, s3] = [...container.querySelectorAll('circle')];
    expect(ec2?.getAttribute('fill')).toBe('#ef4444');
    expect(s3?.getAttribute('fill')).toBe('#10b981');

    // Radius follows current cost: the max-cost entity gets the max radius.
    const ec2R = Number(ec2?.getAttribute('r'));
    const s3R = Number(s3?.getAttribute('r'));
    expect(ec2R).toBeCloseTo(40, 5);
    expect(s3R).toBeGreaterThan(4);
    expect(s3R).toBeLessThan(ec2R);

    // Position encodes the trend: EC2 sits right of S3 (higher % change) and
    // above it (larger absolute delta; the y scale is inverted).
    expect(Number(ec2?.getAttribute('cx'))).toBeGreaterThan(Number(s3?.getAttribute('cx')));
    expect(Number(ec2?.getAttribute('cy'))).toBeLessThan(Number(s3?.getAttribute('cy')));

    expect(screen.getByText('Percent Change')).toBeDefined();
    expect(screen.getByText('Absolute Delta ($)')).toBeDefined();
    expect(screen.getByLabelText(/Cost trend bubble chart/)).toBeDefined();
  });

  it('reports bubble clicks with the entity', async () => {
    const user = userEvent.setup();
    const onEntityClick = vi.fn();
    const { container } = renderChart(
      <BubbleChart data={TREND} onEntityClick={onEntityClick} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(2);
    });
    const first = container.querySelector('circle');
    if (first === null) throw new Error('no circle rendered');
    await user.click(first);
    expect(onEntityClick).toHaveBeenCalledWith(asEntityRef('EC2'));
  });
});
