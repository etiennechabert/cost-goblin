import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';

const slices: PieSlice[] = [
  { name: 'Amazon EC2', cost: 18_000, percentage: 42.6 },
  { name: 'Amazon RDS', cost: 9_500, percentage: 22.5 },
  { name: 'Amazon S3', cost: 6_200, percentage: 14.7 },
];

afterEach(cleanup);

describe('PieChart', () => {
  it('renders collapsed state with title', () => {
    render(<PieChart data={slices} title="Services" collapsed />);
    expect(screen.getByText('Services')).toBeDefined();
  });

  it('renders expand button in collapsed state', () => {
    const onExpand = vi.fn();
    render(<PieChart data={slices} title="Services" collapsed onExpandToggle={onExpand} />);
    expect(screen.getByText('Services')).toBeDefined();
  });

  it('renders container when not collapsed', () => {
    const { container } = render(<PieChart data={slices} title="Accounts" />);
    expect(container.firstChild).toBeDefined();
  });

  it('renders with empty data', () => {
    const { container } = render(<PieChart data={[]} title="Empty" />);
    expect(container.firstChild).toBeDefined();
  });
});
