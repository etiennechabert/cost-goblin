import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostTable } from '../components/cost-table.js';
import { asEntityRef, asDollars } from '@costgoblin/core/browser';
import type { CostRow } from '@costgoblin/core/browser';

const rows: CostRow[] = [
  {
    entity: asEntityRef('platform'),
    totalCost: asDollars(42_000),
    serviceCosts: { 'Amazon EC2': asDollars(18_000), 'Amazon RDS': asDollars(9_500) },
  },
  {
    entity: asEntityRef('data'),
    totalCost: asDollars(31_000),
    serviceCosts: { 'Amazon EC2': asDollars(10_000), 'Amazon RDS': asDollars(14_000) },
  },
  {
    entity: asEntityRef('infra'),
    totalCost: asDollars(14_000),
    serviceCosts: { 'Amazon EC2': asDollars(9_000) },
    isVirtual: true,
  },
];

const topServices = ['Amazon EC2', 'Amazon RDS'];

afterEach(cleanup);

describe('CostTable', () => {
  it('renders entity names', () => {
    render(<CostTable rows={rows} topServices={topServices} onEntityClick={vi.fn()} />);
    expect(screen.getByText('platform')).toBeDefined();
    expect(screen.getByText('data')).toBeDefined();
    expect(screen.getByText('infra')).toBeDefined();
  });

  it('renders service column headers', () => {
    render(<CostTable rows={rows} topServices={topServices} onEntityClick={vi.fn()} />);
    expect(screen.getByText('Amazon EC2')).toBeDefined();
    expect(screen.getByText('Amazon RDS')).toBeDefined();
  });

  it('renders total column header', () => {
    render(<CostTable rows={rows} topServices={topServices} onEntityClick={vi.fn()} />);
    expect(screen.getByText('Total')).toBeDefined();
  });

  it('sorts rows by cost descending', () => {
    const { container } = render(<CostTable rows={rows} topServices={topServices} onEntityClick={vi.fn()} />);
    const entityCells = container.querySelectorAll('tbody td:first-child');
    const names = [...entityCells].map(td => td.textContent);
    expect(names[0]).toContain('platform');
    expect(names[1]).toContain('data');
    expect(names[2]).toContain('infra');
  });

  it('calls onEntityClick when entity name clicked', async () => {
    const onEntityClick = vi.fn();
    const user = userEvent.setup();
    render(<CostTable rows={rows} topServices={topServices} onEntityClick={onEntityClick} />);
    await user.click(screen.getByText('platform'));
    expect(onEntityClick).toHaveBeenCalledWith('platform');
  });

  it('shows dash for missing service costs', () => {
    render(<CostTable rows={rows} topServices={topServices} onEntityClick={vi.fn()} />);
    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('shows virtual entity styling with folder icon', () => {
    render(<CostTable rows={rows} topServices={topServices} onEntityClick={vi.fn()} />);
    const infraBtn = screen.getByText('infra');
    expect(infraBtn.className).toContain('text-warning');
  });

  it('calls onServiceClick when service header clicked', async () => {
    const onServiceClick = vi.fn();
    const user = userEvent.setup();
    render(<CostTable rows={rows} topServices={topServices} onEntityClick={vi.fn()} onServiceClick={onServiceClick} />);
    await user.click(screen.getByText('Amazon EC2'));
    expect(onServiceClick).toHaveBeenCalledWith('Amazon EC2');
  });
});
