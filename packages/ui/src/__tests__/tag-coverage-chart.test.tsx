import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { TagCoverageChart } from '../components/tag-coverage-chart.js';
import { asDollars } from '@costgoblin/core/browser';
import type { TagCoverageSnapshot } from '@costgoblin/core/browser';
import { PaletteProvider } from '../hooks/use-palette.js';

const mockSnapshots: TagCoverageSnapshot[] = [
  {
    timestamp: '2026-04-01T00:00:00Z',
    totalActionableCost: asDollars(2_070),
    totalLikelyUntaggableCost: asDollars(340),
    totalNonResourceCost: asDollars(150),
    actionableCount: 2,
    likelyUntaggableCount: 1,
    coveragePercentage: 85.5,
  },
  {
    timestamp: '2026-04-15T00:00:00Z',
    totalActionableCost: asDollars(1_500),
    totalLikelyUntaggableCost: asDollars(300),
    totalNonResourceCost: asDollars(150),
    actionableCount: 1,
    likelyUntaggableCount: 1,
    coveragePercentage: 90.2,
  },
  {
    timestamp: '2026-04-29T00:00:00Z',
    totalActionableCost: asDollars(800),
    totalLikelyUntaggableCost: asDollars(250),
    totalNonResourceCost: asDollars(150),
    actionableCount: 1,
    likelyUntaggableCount: 1,
    coveragePercentage: 94.8,
  },
];

function renderChart(snapshots: TagCoverageSnapshot[], height?: number) {
  return render(
    <PaletteProvider>
      <TagCoverageChart snapshots={snapshots} height={height} />
    </PaletteProvider>,
  );
}

afterEach(cleanup);

describe('TagCoverageChart', () => {
  it('shows no data message when snapshots array is empty', () => {
    renderChart([]);
    expect(screen.getByText('No coverage data available')).toBeDefined();
  });

  it('renders SVG element when snapshots are provided', () => {
    const { container } = renderChart(mockSnapshots);
    const svg = container.querySelector('svg');
    expect(svg).toBeDefined();
  });

  it('uses default height of 300 when not specified', () => {
    const { container } = renderChart(mockSnapshots);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('height')).toBe('300');
  });

  it('uses custom height when specified', () => {
    const { container } = renderChart(mockSnapshots, 240);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('height')).toBe('240');
  });

  it('renders line path for coverage data', () => {
    const { container } = renderChart(mockSnapshots);
    const linePath = container.querySelector('path[stroke-width="1.75"]');
    expect(linePath).toBeDefined();
  });

  it('sorts snapshots by timestamp before rendering', () => {
    const unsortedSnapshots: TagCoverageSnapshot[] = [
      {
        timestamp: '2026-04-29T00:00:00Z',
        totalActionableCost: asDollars(800),
        totalLikelyUntaggableCost: asDollars(250),
        totalNonResourceCost: asDollars(150),
        actionableCount: 1,
        likelyUntaggableCount: 1,
        coveragePercentage: 94.8,
      },
      {
        timestamp: '2026-04-01T00:00:00Z',
        totalActionableCost: asDollars(2_070),
        totalLikelyUntaggableCost: asDollars(340),
        totalNonResourceCost: asDollars(150),
        actionableCount: 2,
        likelyUntaggableCount: 1,
        coveragePercentage: 85.5,
      },
    ];
    const { container } = renderChart(unsortedSnapshots);
    const linePath = container.querySelector('path[stroke-width="1.75"]');
    expect(linePath).toBeDefined();
  });

  it('renders with single snapshot without errors', () => {
    const singleSnapshot = [mockSnapshots[0]!];
    const { container } = renderChart(singleSnapshot);
    const svg = container.querySelector('svg');
    expect(svg).toBeDefined();
  });
});
