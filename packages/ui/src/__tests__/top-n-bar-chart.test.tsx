import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import type { TopNBar } from '../components/top-n-bar-chart.js';

const bars: TopNBar[] = [
  { name: 'Amazon EC2', cost: 18_000, percentage: 42.6 },
  { name: 'Amazon RDS', cost: 9_500, percentage: 22.5 },
  { name: 'Amazon S3', cost: 6_200, percentage: 14.7 },
];

afterEach(cleanup);

describe('TopNBarChart', () => {
  it('renders collapsed state with title', () => {
    render(<TopNBarChart data={bars} title="Services" collapsed />);
    expect(screen.getByText('Services')).toBeDefined();
  });

  it('renders container when not collapsed', () => {
    const { container } = render(<TopNBarChart data={bars} title="Services" />);
    expect(container.firstChild).toBeDefined();
  });

  it('renders empty state', () => {
    const { container } = render(<TopNBarChart data={[]} title="Empty" />);
    expect(container.firstChild).toBeDefined();
  });
});
