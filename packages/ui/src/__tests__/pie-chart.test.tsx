import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDimensionId } from '@costgoblin/core/browser';
import type { Dimension } from '@costgoblin/core/browser';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { PALETTE_STANDARD, assignSeriesColors, getActivePalette } from '../lib/palette.js';
import { takeMemoRenders } from './memo-renders.js';

vi.mock('react', async (importOriginal) =>
  (await import('./memo-renders.js')).withMemoSpy(await importOriginal<typeof import('react')>()));

beforeEach(() => {
  takeMemoRenders();
});

/** How many times the slices and the legend rows rendered since the last call
 *  (or the start of the test). */
function takeRenders(): Readonly<Record<string, number>> {
  return takeMemoRenders('PieSliceMark', 'PieLegendRow');
}

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

  it('keeps a real Other and the folded remainder apart on hover', async () => {
    const onSliceHover = vi.fn<(name: string | null) => void>();
    const data = [{ name: 'Other', cost: 500, percentage: 50 }, ...SLICES.slice(1)];
    const { container } = renderPie(<PieChart data={data} title="t" maxSlices={2} onSliceHover={onSliceHover} />);
    const groups = await slices(container, 3);
    const [real, , folded] = [slice(groups, 0), slice(groups, 1), slice(groups, 2)];

    // The remainder is no entity: it lights only itself and reports no hover.
    fireEvent.mouseEnter(folded);
    expect(onSliceHover).toHaveBeenLastCalledWith(null);
    expect(slicePath(folded).getAttribute('opacity')).toBe('1');
    expect(slicePath(real).getAttribute('opacity')).toBe('0.3');

    fireEvent.mouseEnter(real);
    expect(onSliceHover).toHaveBeenLastCalledWith('Other');
    expect(slicePath(folded).getAttribute('opacity')).toBe('0.3');
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

// A dashboard renders its pies on every cross-chart hover: the widget reads
// the focus and hands the chart new handler closures. A pie of 50 slices has
// 50 legend rows, each formatting a cost.
describe('PieChart — what a hover renders', () => {
  type PieProps = React.ComponentProps<typeof PieChart>;

  function pie(props: Partial<PieProps>): React.ReactElement {
    return <PaletteProvider><PieChart data={SLICES} title="t" {...props} /></PaletteProvider>;
  }

  it('renders only the slice and the legend row that take or lose the focus when it moves', async () => {
    const { container, rerender } = render(pie({ externalHoveredName: 'EC2', previousCosts: PREVIOUS, onSliceClick: vi.fn() }));
    const groups = await slices(container, 4);
    takeRenders();

    rerender(pie({ externalHoveredName: 'RDS', previousCosts: PREVIOUS, onSliceClick: vi.fn() }));

    expect(slicePath(slice(groups, 2)).getAttribute('stroke')).toBe('#ffffff');
    expect(slicePath(slice(groups, 0)).getAttribute('stroke')).toBe('transparent');
    expect(screen.getByText('RDS').className).toContain('font-semibold');
    expect(screen.getByText('EC2').className).toContain('text-text-muted');
    expect(takeRenders()).toEqual({ PieSliceMark: 2, PieLegendRow: 2 });
  });

  it('renders them all when a focus appears or goes: every other slice dims or lights up again', async () => {
    const { container, rerender } = render(pie({}));
    const groups = await slices(container, 4);
    takeRenders();

    rerender(pie({ externalHoveredName: 'S3' }));
    expect(slicePath(slice(groups, 0)).getAttribute('opacity')).toBe('0.3');
    expect(takeRenders()).toEqual({ PieSliceMark: 4, PieLegendRow: 4 });

    rerender(pie({ externalHoveredName: null }));
    expect(slicePath(slice(groups, 0)).getAttribute('opacity')).toBe('1');
    expect(takeRenders()).toEqual({ PieSliceMark: 4, PieLegendRow: 4 });
  });

  it('renders the two slices its own hover moves between', async () => {
    const { container } = render(pie({ maxSlices: 3 }));
    const groups = await slices(container, 4);
    fireEvent.mouseEnter(slice(groups, 0));
    takeRenders();

    fireEvent.mouseEnter(slice(groups, 1));
    expect(takeRenders()).toEqual({ PieSliceMark: 2, PieLegendRow: 2 });

    // Onto the folded remainder, from the legend.
    fireEvent.mouseEnter(screen.getByText('Other'));
    expect(slicePath(slice(groups, 3)).getAttribute('stroke')).toBe('#ffffff');
    expect(takeRenders()).toEqual({ PieSliceMark: 2, PieLegendRow: 2 });
  });

  it('renders no slice or row when its host renders it again, and calls the handlers of that render', async () => {
    const first = { onSliceClick: vi.fn<(name: string) => void>(), onSliceHover: vi.fn<(name: string | null) => void>() };
    const second = { onSliceClick: vi.fn<(name: string) => void>(), onSliceHover: vi.fn<(name: string | null) => void>() };
    const { container, rerender } = render(pie({ ...first, title: <span>By service</span>, previousCosts: PREVIOUS }));
    const groups = await slices(container, 4);
    takeRenders();

    rerender(pie({ ...second, title: <span>By service</span>, previousCosts: PREVIOUS }));
    expect(takeRenders()).toEqual({ PieSliceMark: 0, PieLegendRow: 0 });

    fireEvent.click(slice(groups, 1));
    fireEvent.keyDown(slice(groups, 2), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Lambda/ }));
    expect(second.onSliceClick.mock.calls).toEqual([['S3'], ['RDS'], ['Lambda']]);
    fireEvent.mouseEnter(slice(groups, 0));
    expect(second.onSliceHover.mock.calls).toEqual([['EC2']]);
    fireEvent.mouseLeave(slice(groups, 0));
    expect(second.onSliceHover).toHaveBeenLastCalledWith(null);
    expect(first.onSliceClick).not.toHaveBeenCalled();
    expect(first.onSliceHover).not.toHaveBeenCalled();
  });

  it('makes its slices clickable, or inert again, when the host adds or drops the click handler', async () => {
    const onSliceClick = vi.fn<(name: string) => void>();
    const { container, rerender } = render(pie({}));
    const groups = await slices(container, 4);
    expect(slice(groups, 0).getAttribute('role')).toBeNull();
    expect(screen.queryByRole('button', { name: /EC2/ })).toBeNull();

    rerender(pie({ onSliceClick }));
    expect(slice(groups, 0).getAttribute('role')).toBe('button');
    fireEvent.click(screen.getByRole('button', { name: /EC2/ }));
    expect(onSliceClick.mock.calls).toEqual([['EC2']]);

    rerender(pie({}));
    expect(slice(groups, 0).getAttribute('role')).toBeNull();
    fireEvent.click(slice(groups, 0));
    expect(onSliceClick).toHaveBeenCalledTimes(1);
  });

  // What a slice or a row shows comes from its props alone: these are the
  // inputs, other than the focus, that have to reach them.
  it('draws again what the palette, the previous costs and the data change', async () => {
    const tree = (props: Partial<PieProps>, palette: 'standard' | 'colorblind'): React.ReactElement => (
      <PaletteProvider palette={palette}><PieChart data={SLICES} title="t" {...props} /></PaletteProvider>
    );
    const { container, rerender } = render(tree({}, 'standard'));
    const groups = await slices(container, 4);
    const fills = (): (string | null)[] => groups.map(g => slicePath(g).getAttribute('fill'));
    const swatches = (): string[] => [...container.querySelectorAll<HTMLElement>('span.inline-block')].map(el => el.style.backgroundColor);
    const standardFills = fills();
    const standardSwatches = swatches();
    takeRenders();

    rerender(tree({}, 'colorblind'));
    const colorblind = assignSeriesColors(SLICES, getActivePalette('colorblind', 'dark'), { colorblind: true });
    expect(fills()).toEqual(SLICES.map(s => colorblind(s.name)));
    expect(fills()).not.toEqual(standardFills);
    expect(swatches()).toHaveLength(4);
    expect(swatches()).not.toEqual(standardSwatches);
    expect(takeRenders()).toEqual({ PieSliceMark: 4, PieLegendRow: 4 });

    // EC2, S3 and RDS get a previous cost, Lambda has none: its row stays.
    rerender(tree({ previousCosts: PREVIOUS }, 'colorblind'));
    expect(screen.getByText('↑25.0%').className).toContain('text-negative');
    expect(screen.getByText('↓25.0%').className).toContain('text-positive');
    expect(takeRenders()).toEqual({ PieSliceMark: 0, PieLegendRow: 3 });

    const halved = SLICES.map(s => ({ ...s, cost: s.cost / 2 }));
    rerender(tree({ data: halved, previousCosts: PREVIOUS }, 'colorblind'));
    expect(screen.getByText('$250.00 (50.0%)')).not.toBeNull();
    expect(screen.queryByText('$500.00 (50.0%)')).toBeNull();
    expect(screen.getByText('↓37.5%').className).toContain('text-positive');
    expect(takeRenders()).toEqual({ PieSliceMark: 4, PieLegendRow: 4 });
  });

  it('scrolls the legend to the row that takes the focus, each time it moves', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { container, rerender } = render(pie({ externalHoveredName: 'EC2' }));
    await slices(container, 4);
    scroll.mockClear();

    rerender(pie({ externalHoveredName: 'Lambda' }));
    expect(scroll.mock.contexts).toHaveLength(1);
    const scrolled = scroll.mock.contexts[0];
    expect(scrolled instanceof HTMLElement && scrolled.textContent.startsWith('Lambda')).toBe(true);

    // The same focus again scrolls nothing.
    rerender(pie({ externalHoveredName: 'Lambda' }));
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
