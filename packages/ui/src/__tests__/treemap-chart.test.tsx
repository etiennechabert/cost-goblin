import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TreemapChart } from '../components/treemap-chart.js';
import type { TreemapCell } from '../components/treemap-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';

const CELLS: readonly TreemapCell[] = [
  { name: 'EC2', cost: 500 },
  { name: 'S3', cost: 300 },
  { name: 'RDS', cost: 200 },
];

function renderTreemap(ui: React.ReactElement) {
  return render(<PaletteProvider>{ui}</PaletteProvider>);
}

/** The treemap's cells (one rect each). jsdom has no SVGRectElement, so
 *  narrow to SVGElement. */
function rectsIn(container: HTMLElement): SVGElement[] {
  return [...container.querySelectorAll('svg rect')].filter((r): r is SVGElement => r instanceof SVGElement);
}

/** The cells, once the measured body has mounted. */
async function cells(container: HTMLElement, count: number): Promise<SVGElement[]> {
  await waitFor(() => { expect(container.querySelectorAll('svg rect')).toHaveLength(count); });
  return rectsIn(container);
}

/** The cell whose accessible name starts with `name`. */
function cell(rects: readonly SVGElement[], name: string): SVGElement {
  const found = rects.find(r => r.getAttribute('aria-label')?.startsWith(`${name} — `) === true);
  if (found === undefined) throw new Error(`no cell for ${name}`);
  return found;
}

describe('TreemapChart', () => {
  it('draws one labelled cell per entity, sized by cost', async () => {
    const { container } = renderTreemap(<TreemapChart data={CELLS} title="Spend map" subtitle="Click to filter" />);
    const rects = await cells(container, 3);

    expect(screen.getByText('Spend map')).toBeDefined();
    expect(screen.getByText('Click to filter')).toBeDefined();

    const area = (r: SVGElement) => Number(r.getAttribute('width')) * Number(r.getAttribute('height'));
    expect(area(cell(rects, 'EC2'))).toBeGreaterThan(area(cell(rects, 'S3')));
    expect(area(cell(rects, 'S3'))).toBeGreaterThan(area(cell(rects, 'RDS')));
    // The cells tile the whole measured body.
    expect(rects.reduce((sum, r) => sum + area(r), 0)).toBeCloseTo(800 * 600, 6);

    // Big enough cells carry their name and cost.
    expect(screen.getByText('EC2')).toBeDefined();
    expect(screen.getByText('$500.00')).toBeDefined();
    expect(cell(rects, 'S3').getAttribute('aria-label')).toBe('S3 — $300.00');
  });

  it('reports hover and click, and dims around an external hover', async () => {
    const onCellClick = vi.fn<(name: string) => void>();
    const onCellHover = vi.fn<(name: string | null) => void>();
    const { container, rerender } = renderTreemap(
      <TreemapChart data={CELLS} onCellClick={onCellClick} onCellHover={onCellHover} />,
    );
    const rects = await cells(container, 3);
    const s3 = cell(rects, 'S3');

    expect(s3.style.cursor).toBe('pointer');
    expect(s3.getAttribute('fill-opacity')).toBe('0.85');

    fireEvent.mouseEnter(s3);
    expect(onCellHover).toHaveBeenLastCalledWith('S3');
    fireEvent.click(s3);
    expect(onCellClick).toHaveBeenCalledWith('S3');
    fireEvent.mouseLeave(s3);
    expect(onCellHover).toHaveBeenLastCalledWith(null);

    // The host feeds the hover back as cross-chart focus.
    rerender(
      <PaletteProvider>
        <TreemapChart data={CELLS} onCellClick={onCellClick} onCellHover={onCellHover} externalHoveredName="S3" />
      </PaletteProvider>,
    );
    const focused = cell(rectsIn(container), 'S3');
    expect(focused.getAttribute('stroke')).toBe('#ffffff');
    expect(focused.getAttribute('stroke-width')).toBe('2');
    expect(focused.getAttribute('fill-opacity')).toBe('0.85');
    const ec2 = cell(rectsIn(container), 'EC2');
    expect(ec2.getAttribute('fill-opacity')).toBe('0.35');
    expect(ec2.getAttribute('stroke-width')).toBe('1.5');

    // Leaving the whole chart clears the hover too.
    onCellHover.mockClear();
    const frame = container.querySelector('.rounded-xl');
    if (frame === null) throw new Error('no chart frame');
    fireEvent.mouseLeave(frame);
    expect(onCellHover).toHaveBeenCalledWith(null);
  });

  it('is inert without handlers', async () => {
    const { container } = renderTreemap(<TreemapChart data={CELLS} />);
    const rects = await cells(container, 3);
    const ec2 = cell(rects, 'EC2');

    expect(ec2.style.cursor).toBe('default');
    // Nobody is listening: hovering, clicking and leaving are no-ops.
    fireEvent.mouseEnter(ec2);
    fireEvent.click(ec2);
    fireEvent.mouseLeave(ec2);
    const frame = container.querySelector('.rounded-xl');
    if (frame === null) throw new Error('no chart frame');
    fireEvent.mouseLeave(frame);
    expect(ec2.getAttribute('fill-opacity')).toBe('0.85');
  });

  it('annotates cells with the change against the previous period', async () => {
    const previous = new Map([['EC2', 400], ['S3', 600], ['RDS', 0]]);
    const { container } = renderTreemap(<TreemapChart data={CELLS} previousCosts={previous} />);
    const rects = await cells(container, 3);

    expect(cell(rects, 'EC2').getAttribute('aria-label')).toBe('EC2 — $500.00 (↑25.0%)');
    expect(cell(rects, 'S3').getAttribute('aria-label')).toBe('S3 — $300.00 (↓50.0%)');
    // No ratio against a zero previous cost.
    expect(cell(rects, 'RDS').getAttribute('aria-label')).toBe('RDS — $200.00');

    const up = [...container.querySelectorAll('tspan')].find(t => t.textContent === ' ↑25.0%');
    const down = [...container.querySelectorAll('tspan')].find(t => t.textContent === ' ↓50.0%');
    expect(up?.getAttribute('fill')).toBe('#fecaca');
    expect(down?.getAttribute('fill')).toBe('#bbf7d0');
    expect(container.querySelectorAll('tspan')).toHaveLength(2);
  });

  it('truncates a name too long for its cell', async () => {
    const longName = 'x'.repeat(150);
    const { container } = renderTreemap(<TreemapChart data={[{ name: longName, cost: 10 }]} />);
    await cells(container, 1);

    // An 800px cell fits floor(800 / 7) = 114 characters.
    const label = container.querySelector('text');
    expect(label?.textContent).toBe(`${'x'.repeat(113)}…`);
  });

  it('leaves slivers unlabelled', async () => {
    const { container } = renderTreemap(
      <TreemapChart data={[{ name: 'Big', cost: 100_000 }, { name: 'Tiny', cost: 1 }]} />,
    );
    const rects = await cells(container, 2);

    expect(screen.getByText('Big')).toBeDefined();
    expect(screen.queryByText('Tiny')).toBeNull();
    // It is still in the map, with its tooltip.
    expect(cell(rects, 'Tiny').getAttribute('aria-label')).toBe('Tiny — $1.00');
  });

  it('says so when there is nothing to draw', async () => {
    const { container } = renderTreemap(<TreemapChart data={[]} subtitle="Top 10" />);

    expect(await screen.findByText('No data')).toBeDefined();
    expect(screen.getByText('Top 10')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders no header without a title or subtitle', async () => {
    const { container } = renderTreemap(<TreemapChart data={CELLS} />);
    await cells(container, 3);

    expect(container.querySelector('h3')).toBeNull();
  });
});
