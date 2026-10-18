import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { asDollars, asEntityRef } from '@costgoblin/core/browser';
import type { TrendRow } from '@costgoblin/core/browser';
import { PaletteProvider } from '../hooks/use-palette.js';
import { WaterfallChart } from '../components/waterfall-chart.js';
import { ParetoChart } from '../components/pareto-chart.js';
import { BurndownChart } from '../components/burndown-chart.js';
import { PriceVolumeChart } from '../components/price-volume-chart.js';
import { HeatmapChart } from '../components/heatmap-chart.js';
import { TreemapChart } from '../components/treemap-chart.js';
import { buildWaterfall } from '../lib/waterfall.js';
import { buildPareto } from '../lib/concentration.js';
import type { PriceVolumeDecomp } from '../lib/price-volume.js';

// Hover behaviour of the hand-drawn analysis charts. The mocked ResizeObserver
// (setup.ts) reports an 800px-wide container, and in jsdom visx's localPoint
// falls back to clientX, so a mouse move at clientX lands at that SVG x.

function renderChart(ui: React.ReactElement) {
  return render(<PaletteProvider>{ui}</PaletteProvider>);
}

async function hover(container: HTMLElement, selector: string, clientX = 0): Promise<HTMLElement> {
  const target = await waitFor(() => {
    const el = container.querySelector(selector);
    if (el === null) throw new Error(`no element matches ${selector}`);
    return el;
  });
  fireEvent.mouseMove(target, { clientX, clientY: 40 });
  return screen.findByRole('tooltip');
}

function trendRow(entity: string, previousCost: number, currentCost: number): TrendRow {
  return {
    entity: asEntityRef(entity),
    previousCost: asDollars(previousCost),
    currentCost: asDollars(currentCost),
    delta: asDollars(currentCost - previousCost),
    percentChange: previousCost === 0 ? 0 : ((currentCost - previousCost) / previousCost) * 100,
  };
}

describe('WaterfallChart', () => {
  // $9.3k → $11.2k: a change small next to the totals.
  const model = buildWaterfall([trendRow('EC2', 6000, 7500), trendRow('VPC', 2000, 2300), trendRow('S3', 1300, 1400)], 8);

  it('zooms the axis onto a small change and draws the totals cut', async () => {
    const { container } = renderChart(<WaterfallChart model={model} title="Service bridge" />);
    await waitFor(() => { expect(container.querySelectorAll('[data-cut]')).toHaveLength(2); });
    // The axis floor sits under the lowest level, not at $0.
    expect(screen.getByText('$8.3k')).toBeDefined();
    expect(screen.queryByText('$0.00')).toBeNull();
    // Both totals and the biggest movers carry a value label.
    expect(screen.getByText('$9.3k')).toBeDefined();
    expect(screen.getByText('+$1.5k')).toBeDefined();
  });

  it('explains a mover on hover', async () => {
    const { container } = renderChart(<WaterfallChart model={model} title="Service bridge" />);
    const tip = await hover(container, '[data-step="VPC"]');
    expect(tip.textContent).toContain('VPC');
    expect(tip.textContent).toContain('+$300.00');
    expect(tip.textContent).toContain('Running total');
  });
});

describe('ParetoChart', () => {
  it('shows cost, share, cumulative share and rank on hover', async () => {
    const model = buildPareto([{ name: 'EC2', cost: 600 }, { name: 'S3', cost: 300 }, { name: 'RDS', cost: 100 }], 3);
    const { container } = renderChart(<ParetoChart model={model} title="Service concentration" />);
    const tip = await hover(container, '[data-point="S3"]');
    expect(tip.textContent).toContain('S3');
    expect(tip.textContent).toContain('$300.00');
    expect(tip.textContent).toContain('Share of spend30.0%');
    expect(tip.textContent).toContain('Top 2 together90.0%');
    expect(tip.textContent).toContain('2 of 3');
  });
});

describe('BurndownChart', () => {
  const current = [
    { dayIndex: 0, date: '2026-09-15', cumulative: 100 },
    { dayIndex: 1, date: '2026-09-16', cumulative: 220 },
    { dayIndex: 3, date: '2026-09-18', cumulative: 400 },
  ];
  const previous = [
    { dayIndex: 0, date: '2026-08-15', cumulative: 90 },
    { dayIndex: 1, date: '2026-08-16', cumulative: 200 },
    { dayIndex: 2, date: '2026-08-17', cumulative: 300 },
  ];
  // 800px container: the plot runs from x=56 over 728px, one day per 728/9px.
  const PLOT_LEFT = 56;
  const DAY_PX = 728 / 9;

  function renderBurndown() {
    return renderChart(
      <BurndownChart current={current} previous={previous} totalDays={10} projected={1000} periodStart="2026-09-15" title="Pacing" />,
    );
  }

  it('compares both periods at the hovered day', async () => {
    const { container } = renderBurndown();
    const tip = await hover(container, '[data-testid="burndown-hit-area"]', PLOT_LEFT + 2 * DAY_PX);
    expect(tip.textContent).toContain('Sep 17 · day 3');
    // Day 3 had no spend this period: the running total carries over.
    expect(tip.textContent).toContain('This period$220.00');
    expect(tip.textContent).toContain('Previous period$300.00');
    expect(tip.textContent).toContain('Difference$-80.00 (-26.7%)');
  });

  it('switches to the projection past the last data day', async () => {
    const { container } = renderBurndown();
    const tip = await hover(container, '[data-testid="burndown-hit-area"]', PLOT_LEFT + 9 * DAY_PX);
    expect(tip.textContent).toContain('Sep 24 · day 10');
    expect(tip.textContent).toContain('Projected$1.0k');
  });

  it('labels the series and dates the axis', async () => {
    renderBurndown();
    expect(await screen.findByText('Sep 15')).toBeDefined();
    expect(screen.getByText('Sep 24')).toBeDefined();
    expect(screen.getByText('This period')).toBeDefined();
    expect(screen.getByText('Previous period')).toBeDefined();
    expect(screen.getByText('Projection')).toBeDefined();
  });
});

describe('PriceVolumeChart', () => {
  it('splits a row into volume and rate on hover', async () => {
    const row: PriceVolumeDecomp = {
      name: 'Amazon EC2',
      entity: asEntityRef('Amazon EC2'),
      prevCost: 1000,
      currCost: 1300,
      totalDelta: 300,
      volumeEffect: 200,
      rateEffect: 100,
      decomposable: true,
      prevRate: 0.1,
      currRate: 0.11,
      prevDiscount: 0.2,
      currDiscount: 0.15,
    };
    const { container } = renderChart(<PriceVolumeChart rows={[row]} title="Price vs volume" />);
    const tip = await hover(container, '[data-row="Amazon EC2"]');
    expect(tip.textContent).toContain('Previous$1.0k');
    expect(tip.textContent).toContain('Volume (usage)+$200.00');
    expect(tip.textContent).toContain('Rate (price)+$100.00');
    expect(tip.textContent).toContain('20.0% → 15.0%');
  });
});

describe('HeatmapChart', () => {
  it('names the group, day and cost of a hovered cell', async () => {
    const { container } = renderChart(
      <HeatmapChart cells={[{ group: 'EC2', date: '2026-09-15', cost: 42 }]} groups={['EC2']} dates={['2026-09-15']} />,
    );
    const tip = await hover(container, '[data-cell="EC2-2026-09-15"]');
    expect(tip.textContent).toContain('EC2');
    expect(tip.textContent).toContain('Sep 15$42.00');
  });
});

describe('TreemapChart', () => {
  it('shows the share and the change from the previous period', async () => {
    const { container } = renderChart(
      <TreemapChart
        data={[{ name: 'EC2', cost: 750 }, { name: 'S3', cost: 250 }]}
        previousCosts={new Map([['S3', 200]])}
      />,
    );
    const tip = await hover(container, '[data-cell="S3"]');
    expect(tip.textContent).toContain('Share of spend25.0%');
    expect(tip.textContent).toContain('Previous period$200.00');
    expect(tip.textContent).toContain('+25.0%');
  });
});
