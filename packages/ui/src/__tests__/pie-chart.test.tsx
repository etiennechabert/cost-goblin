import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDimensionId } from '@costgoblin/core/browser';
import type { Dimension } from '@costgoblin/core/browser';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { PALETTE_STANDARD, assignSeriesColors } from '../lib/palette.js';

const SLICES: readonly PieSlice[] = [
  { name: 'EC2', cost: 500, percentage: 50 },
  { name: 'S3', cost: 300, percentage: 30 },
  { name: 'RDS', cost: 120, percentage: 12 },
  { name: 'Lambda', cost: 80, percentage: 8 },
];

// EC2 grew 25%, S3 shrank 25%, RDS had no spend before (no ratio), Lambda is new.
const PREVIOUS: ReadonlyMap<string, number> = new Map([['EC2', 400], ['S3', 400], ['RDS', 0]]);

const DIMS: readonly Dimension[] = [
  { name: asDimensionId('service'), label: 'Service', field: 'service' },
  { name: asDimensionId('region'), label: 'Region', field: 'region' },
];

afterEach(() => { vi.restoreAllMocks(); });

function selectValue(el: HTMLElement): string {
  if (!(el instanceof HTMLSelectElement)) throw new Error('not a select');
  return el.value;
}

function renderPie(ui: React.ReactElement) {
  return render(<PaletteProvider>{ui}</PaletteProvider>);
}

/** The pie's slice groups, in data order (Other last when folded). */
async function slices(container: HTMLElement, count: number): Promise<SVGGElement[]> {
  await waitFor(() => { expect(container.querySelectorAll('svg path')).toHaveLength(count); });
  const groups: SVGGElement[] = [];
  for (const path of container.querySelectorAll('svg path')) {
    const g = path.parentElement;
    if (g instanceof SVGGElement) groups.push(g);
  }
  return groups;
}

function slice(groups: readonly SVGGElement[], index: number): SVGGElement {
  const g = groups[index];
  if (g === undefined) throw new Error(`no slice ${String(index)}`);
  return g;
}

function slicePath(g: SVGGElement): SVGPathElement {
  const path = g.querySelector('path');
  if (path === null) throw new Error('slice has no path');
  return path;
}

describe('PieChart — header', () => {
  it('replaces the title with a group-by picker when dimensions are offered', async () => {
    const user = userEvent.setup();
    const onDimensionChange = vi.fn<(dimId: string) => void>();
    renderPie(
      <PieChart data={SLICES} title="By service" dimensions={DIMS} activeDimensionId="region" onDimensionChange={onDimensionChange} />,
    );

    const picker = await screen.findByRole('combobox', { name: 'Group by dimension' });
    expect(screen.queryByText('By service')).toBeNull();
    expect(selectValue(picker)).toBe('region');

    await user.selectOptions(picker, 'Service');
    expect(onDimensionChange).toHaveBeenCalledWith('service');
  });

  it('keeps the plain title without a change handler, and shows the subtitle and expand toggle', async () => {
    const user = userEvent.setup();
    const onExpandToggle = vi.fn<() => void>();
    renderPie(
      <PieChart data={SLICES} title="By service" subtitle="Top 4" dimensions={DIMS} onExpandToggle={onExpandToggle} />,
    );

    expect(await screen.findByText('By service')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Top 4')).toBeDefined();

    await user.click(screen.getByTitle('Toggle expand'));
    expect(onExpandToggle).toHaveBeenCalledTimes(1);
  });

  it('starts the picker unselected when no dimension is active', async () => {
    renderPie(<PieChart data={SLICES} title="By service" dimensions={DIMS} onDimensionChange={vi.fn()} />);

    const picker = await screen.findByRole('combobox', { name: 'Group by dimension' });
    // An unknown value falls back to the first option.
    expect(selectValue(picker)).toBe('service');
  });

  it('collapses into a vertical title that expands on click', async () => {
    const user = userEvent.setup();
    const onExpandToggle = vi.fn<() => void>();
    const { container } = renderPie(<PieChart data={SLICES} title="By service" collapsed onExpandToggle={onExpandToggle} />);

    expect(container.querySelector('svg')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'By service' }));
    expect(onExpandToggle).toHaveBeenCalledTimes(1);
  });
});

describe('PieChart — slices', () => {
  it('highlights the hovered slice, dims the rest and reports the hover', async () => {
    const onSliceHover = vi.fn<(name: string | null) => void>();
    const { container } = renderPie(<PieChart data={SLICES} title="t" onSliceHover={onSliceHover} />);
    const groups = await slices(container, 4);

    fireEvent.mouseEnter(slice(groups, 1));
    expect(onSliceHover).toHaveBeenLastCalledWith('S3');
    expect(slicePath(slice(groups, 1)).getAttribute('stroke')).toBe('#ffffff');
    expect(slicePath(slice(groups, 1)).getAttribute('opacity')).toBe('1');
    expect(slicePath(slice(groups, 0)).getAttribute('opacity')).toBe('0.3');
    // The legend mirrors it: S3 expands, the others mute.
    expect(screen.getByText('S3').className).toContain('font-semibold');
    expect(screen.getByText('EC2').className).toContain('text-text-muted');

    fireEvent.mouseLeave(slice(groups, 1));
    expect(onSliceHover).toHaveBeenLastCalledWith(null);
    expect(slicePath(slice(groups, 0)).getAttribute('opacity')).toBe('1');
    expect(screen.getByText('EC2').className).toContain('text-text-secondary');
  });

  it('drills down on click and on Enter or Space, but not on other keys', async () => {
    const onSliceClick = vi.fn<(name: string) => void>();
    const { container } = renderPie(<PieChart data={SLICES} title="t" onSliceClick={onSliceClick} />);
    const groups = await slices(container, 4);
    const ec2 = slice(groups, 0);

    expect(ec2.getAttribute('role')).toBe('button');
    expect(ec2.getAttribute('tabindex')).toBe('0');

    fireEvent.click(ec2);
    fireEvent.keyDown(slice(groups, 1), { key: 'Enter' });
    fireEvent.keyDown(slice(groups, 2), { key: ' ' });
    fireEvent.keyDown(slice(groups, 3), { key: 'Tab' });

    expect(onSliceClick.mock.calls).toEqual([['EC2'], ['S3'], ['RDS']]);
  });

  it('keeps the folded Other slice inert', async () => {
    const onSliceClick = vi.fn<(name: string) => void>();
    const { container } = renderPie(<PieChart data={SLICES} title="t" maxSlices={2} onSliceClick={onSliceClick} />);
    const groups = await slices(container, 3);
    const other = slice(groups, 2);

    expect(other.getAttribute('role')).toBeNull();
    expect(other.getAttribute('tabindex')).toBeNull();
    expect(slicePath(other).getAttribute('fill')).toBe('#374151');

    fireEvent.click(other);
    fireEvent.keyDown(other, { key: 'Enter' });
    expect(onSliceClick).not.toHaveBeenCalled();
  });

  it('treats an entity named Other like any other series', async () => {
    // FOCUS has a real "Other" service category; only the folded remainder is gray.
    const onSliceClick = vi.fn<(name: string) => void>();
    const data = [{ name: 'Other', cost: 500, percentage: 50 }, ...SLICES.slice(1)];
    const { container } = renderPie(<PieChart data={data} title="t" onSliceClick={onSliceClick} />);
    const real = slice(await slices(container, 4), 0);

    expect(slicePath(real).getAttribute('fill')).toBe(assignSeriesColors(data, PALETTE_STANDARD)('Other'));
    expect(real.getAttribute('role')).toBe('button');
    fireEvent.click(real);
    expect(onSliceClick.mock.calls).toEqual([['Other']]);
  });

  it('is not focusable without a click handler', async () => {
    const { container } = renderPie(<PieChart data={SLICES} title="t" />);
    const groups = await slices(container, 4);
    const first = slice(groups, 0);

    expect(first.getAttribute('role')).toBeNull();
    // Clicking or pressing Enter is harmless when nobody listens.
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(first.style.cursor).toBe('default');
  });
});

describe('PieChart — legend', () => {
  it('shows period-over-period deltas only where a previous cost exists', async () => {
    renderPie(<PieChart data={SLICES} title="t" previousCosts={PREVIOUS} />);

    const up = await screen.findByText('↑25.0%');
    expect(up.className).toContain('text-negative');
    const down = screen.getByText('↓25.0%');
    expect(down.className).toContain('text-positive');
    // RDS had no previous spend and Lambda no previous row: no badge for either.
    expect(screen.getAllByText(/[↑↓]\d/)).toHaveLength(2);
  });

  it('expands the hovered entry with its delta, and collapses it on leave', async () => {
    const user = userEvent.setup();
    renderPie(<PieChart data={SLICES} title="t" previousCosts={PREVIOUS} onSliceClick={vi.fn()} />);

    const s3 = await screen.findByRole('button', { name: /S3/ });
    await user.hover(s3);

    expect(within(s3).getByText('S3').className).toContain('font-semibold');
    expect(within(s3).getByText('↓25.0%').className).toContain('text-positive');
    expect(s3.className).toContain('bg-accent-muted/50');

    // The hovered entry for a slice without a ratio shows no badge.
    await user.hover(screen.getByRole('button', { name: /RDS/ }));
    expect(within(screen.getByRole('button', { name: /RDS/ })).queryByText(/[↑↓]/)).toBeNull();

    await user.hover(screen.getByRole('button', { name: /EC2/ }));
    expect(within(screen.getByRole('button', { name: /EC2/ })).getByText('↑25.0%').className).toContain('text-negative');

    await user.unhover(screen.getByRole('button', { name: /EC2/ }));
    expect(screen.getByRole('button', { name: /EC2/ }).className).not.toContain('bg-accent-muted/50');
  });

  it('follows a hover coming from another chart and scrolls it into view', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { container } = renderPie(<PieChart data={SLICES} title="t" externalHoveredName="RDS" />);
    const groups = await slices(container, 4);

    expect(slicePath(slice(groups, 2)).getAttribute('stroke')).toBe('#ffffff');
    expect(slicePath(slice(groups, 0)).getAttribute('opacity')).toBe('0.3');
    expect(screen.getByText('RDS').className).toContain('font-semibold');
    expect(scroll).toHaveBeenCalled();
  });
});

describe('PieChart — without a legend', () => {
  it('shows a floating label for the hovered slice, with its delta', async () => {
    const { container } = renderPie(<PieChart data={SLICES} title="t" showLegend={false} previousCosts={PREVIOUS} />);
    const groups = await slices(container, 4);

    // No legend entries are rendered at all.
    expect(screen.queryByText('EC2')).toBeNull();

    fireEvent.mouseEnter(slice(groups, 0));
    expect(screen.getByText('EC2')).toBeDefined();
    expect(screen.getByText('$500.00 (50.0%)')).toBeDefined();
    expect(screen.getByText('↑25.0%').className).toContain('text-negative');

    fireEvent.mouseEnter(slice(groups, 1));
    expect(screen.getByText('↓25.0%').className).toContain('text-positive');

    // Zero or missing previous cost: the label shows no delta.
    fireEvent.mouseEnter(slice(groups, 2));
    expect(screen.getByText('RDS')).toBeDefined();
    expect(screen.queryByText(/[↑↓]\d/)).toBeNull();
    fireEvent.mouseEnter(slice(groups, 3));
    expect(screen.getByText('Lambda')).toBeDefined();
    expect(screen.queryByText(/[↑↓]\d/)).toBeNull();

    fireEvent.mouseLeave(slice(groups, 3));
    expect(screen.queryByText('Lambda')).toBeNull();
  });

  it('shows no delta without previous costs', async () => {
    const { container } = renderPie(<PieChart data={SLICES} title="t" showLegend={false} />);
    const groups = await slices(container, 4);

    fireEvent.mouseEnter(slice(groups, 1));
    expect(screen.getByText('$300.00 (30.0%)')).toBeDefined();
    expect(screen.queryByText(/[↑↓]\d/)).toBeNull();
  });

  it('shows nothing for an external hover on a name it does not plot', async () => {
    const { container } = renderPie(<PieChart data={SLICES} title="t" showLegend={false} externalHoveredName="DynamoDB" />);
    await slices(container, 4);

    expect(screen.queryByText('DynamoDB')).toBeNull();
    // Every slice is dimmed: none of them is the hovered one.
    for (const path of container.querySelectorAll('svg path')) {
      expect(path.getAttribute('opacity')).toBe('0.3');
    }
  });
});
