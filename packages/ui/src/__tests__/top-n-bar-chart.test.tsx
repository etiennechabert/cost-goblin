import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDimensionId } from '@costgoblin/core/browser';
import type { Dimension } from '@costgoblin/core/browser';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import type { TopNBar } from '../components/top-n-bar-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';

const LONG_NAME = 'arn:aws:rds:eu-central-1:analytics-replica';

const BARS: readonly TopNBar[] = [
  { name: 'S3', cost: 250, percentage: 25 },
  { name: 'EC2', cost: 500, percentage: 50 },
  { name: LONG_NAME, cost: 150, percentage: 15 },
  { name: 'Lambda', cost: 100, percentage: 10 },
];

const DIMS: readonly Dimension[] = [
  { name: asDimensionId('service'), label: 'Service', field: 'service' },
  { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
];

function renderBars(ui: React.ReactElement) {
  return render(<PaletteProvider>{ui}</PaletteProvider>);
}

/** A bar's row, found by its "name — cost" tooltip. */
function bar(title: string): HTMLElement {
  return screen.getByTitle(title);
}

/** The coloured bar inside a row. */
function fill(row: HTMLElement): HTMLElement {
  const el = row.querySelector('.rounded-sm');
  if (!(el instanceof HTMLElement)) throw new Error('row has no bar');
  return el;
}

describe('TopNBarChart — ranking', () => {
  it('ranks entities by cost, scales bars to the largest, and truncates long names', async () => {
    renderBars(<TopNBarChart data={BARS} title="Top services" subtitle="Click to filter" />);

    const rows = await screen.findAllByRole('listitem');
    expect(rows.map(r => r.getAttribute('title'))).toEqual([
      'EC2 — $500.00',
      'S3 — $250.00',
      `${LONG_NAME} — $150.00`,
      'Lambda — $100.00',
    ]);
    expect(screen.getByText('Top services')).toBeDefined();
    expect(screen.getByText('Click to filter')).toBeDefined();

    // 800px wide container: 800 − 140 label − 90 gutter = 570px of bar area.
    expect(fill(bar('EC2 — $500.00')).style.width).toBe('570px');
    expect(fill(bar('S3 — $250.00')).style.width).toBe('285px');

    expect(screen.getByText('arn:aws:rds:eu-centra…')).toBeDefined();
    expect(within(bar('EC2 — $500.00')).getByText('(50.0%)')).toBeDefined();
  });

  it('keeps only the top N', async () => {
    renderBars(<TopNBarChart data={BARS} title="t" topN={2} />);

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(screen.queryByTitle('Lambda — $100.00')).toBeNull();
  });

  it('says so when there is nothing to rank', async () => {
    renderBars(<TopNBarChart data={[]} title="t" />);

    expect(await screen.findByText('No data')).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('draws a sliver for entities that cost nothing', async () => {
    renderBars(<TopNBarChart data={[{ name: 'Free', cost: 0, percentage: 0 }]} title="t" />);

    const row = await screen.findByTitle('Free — $0.00');
    expect(fill(row).style.width).toBe('1px');
  });
});

describe('TopNBarChart — interaction', () => {
  it('highlights the hovered bar, dims the others and reports the hover', async () => {
    const onBarHover = vi.fn<(name: string | null) => void>();
    renderBars(<TopNBarChart data={BARS} title="t" onBarHover={onBarHover} />);
    const ec2 = await screen.findByTitle('EC2 — $500.00');

    fireEvent.mouseEnter(ec2);
    expect(onBarHover).toHaveBeenLastCalledWith('EC2');
    expect(ec2.style.opacity).toBe('1');
    expect(ec2.style.backgroundColor).toBe('var(--color-accent-muted)');
    expect(fill(ec2).style.filter).toBe('brightness(1.2)');
    expect(bar('S3 — $250.00').style.opacity).toBe('0.4');

    fireEvent.mouseLeave(ec2);
    expect(onBarHover).toHaveBeenLastCalledWith(null);
    expect(bar('S3 — $250.00').style.opacity).toBe('1');
    expect(fill(ec2).style.filter).toBe('none');
  });

  it('filters on click when a handler is given', async () => {
    const user = userEvent.setup();
    const onBarClick = vi.fn<(name: string) => void>();
    renderBars(<TopNBarChart data={BARS} title="t" onBarClick={onBarClick} />);

    await user.click(await screen.findByRole('button', { name: /^S3/ }));
    expect(onBarClick).toHaveBeenCalledWith('S3');
  });

  it('renders plain rows without a click handler', async () => {
    renderBars(<TopNBarChart data={BARS} title="t" />);

    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button')).toBeNull();
    // Hovering still works without anyone listening.
    fireEvent.mouseEnter(bar('S3 — $250.00'));
    expect(bar('EC2 — $500.00').style.opacity).toBe('0.4');
  });

  it('follows a hover from another chart', async () => {
    renderBars(<TopNBarChart data={BARS} title="t" externalHoveredName="Lambda" />);

    const lambda = await screen.findByTitle('Lambda — $100.00');
    expect(lambda.style.opacity).toBe('1');
    expect(bar('EC2 — $500.00').style.opacity).toBe('0.4');
  });

  it('shows previous-period deltas where a previous cost exists', async () => {
    const previous = new Map([['EC2', 400], ['S3', 500], ['Lambda', 0]]);
    renderBars(<TopNBarChart data={BARS} title="t" previousCosts={previous} />);

    const ec2 = await screen.findByTitle('EC2 — $500.00');
    expect(within(ec2).getByText('↑25.0%').className).toContain('text-negative');
    expect(within(bar('S3 — $250.00')).getByText('↓50.0%').className).toContain('text-positive');
    // Zero previous cost, or no previous row: no badge.
    expect(within(bar('Lambda — $100.00')).queryByText(/[↑↓]/)).toBeNull();
    expect(within(bar(`${LONG_NAME} — $150.00`)).queryByText(/[↑↓]/)).toBeNull();
  });
});

describe('TopNBarChart — header and collapse', () => {
  it('offers a group-by picker in place of the title', async () => {
    const user = userEvent.setup();
    const onDimensionChange = vi.fn<(dimId: string) => void>();
    renderBars(
      <TopNBarChart data={BARS} title="Top" dimensions={DIMS} activeDimensionId="account" onDimensionChange={onDimensionChange} />,
    );

    const picker = await screen.findByRole('combobox', { name: 'Group by dimension' });
    expect(picker instanceof HTMLSelectElement ? picker.value : null).toBe('account');
    expect(screen.queryByText('Top')).toBeNull();

    await user.selectOptions(picker, 'Service');
    expect(onDimensionChange).toHaveBeenCalledWith('service');
  });

  it('starts the picker on the first option when no dimension is active', async () => {
    renderBars(<TopNBarChart data={BARS} title="Top" dimensions={DIMS} onDimensionChange={vi.fn()} />);

    const picker = await screen.findByRole('combobox', { name: 'Group by dimension' });
    expect(picker instanceof HTMLSelectElement ? picker.value : null).toBe('service');
  });

  it('keeps the title when dimensions come without a change handler', async () => {
    renderBars(<TopNBarChart data={BARS} title="Top" dimensions={DIMS} />);

    expect(await screen.findByText('Top')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('toggles expansion from the header', async () => {
    const user = userEvent.setup();
    const onExpandToggle = vi.fn<() => void>();
    renderBars(<TopNBarChart data={BARS} title="Top" onExpandToggle={onExpandToggle} />);

    await user.click(await screen.findByTitle('Toggle expand'));
    expect(onExpandToggle).toHaveBeenCalledTimes(1);
  });

  it('collapses to its title and expands on click', async () => {
    const user = userEvent.setup();
    const onExpandToggle = vi.fn<() => void>();
    renderBars(<TopNBarChart data={BARS} title="Top" collapsed onExpandToggle={onExpandToggle} />);

    expect(screen.queryByRole('listitem')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Top' }));
    expect(onExpandToggle).toHaveBeenCalledTimes(1);
  });
});
