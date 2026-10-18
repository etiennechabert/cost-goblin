import { describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { LineChart } from '../components/line-chart.js';
import type { LineSeries } from '../components/line-chart.js';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { StackedBarChart } from '../components/stacked-bar-chart.js';
import type { BarDay } from '../components/stacked-bar-chart.js';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import { TreemapChart } from '../components/treemap-chart.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { PALETTE_COLORBLIND, PALETTE_STANDARD, hashSeriesName } from '../lib/palette.js';
import type { PaletteType } from '../lib/palette.js';

// One range's spend, as each widget receives it. EC2 and CloudFront hash to
// the same slot, so the ranking decides which keeps it.
const COSTS = [
  { name: 'EC2', cost: 500 },
  { name: 'CloudFront', cost: 300 },
  { name: 'S3', cost: 200 },
  { name: 'Lambda', cost: 100 },
];
const NAMES = COSTS.map(c => c.name);

const SLICES: readonly PieSlice[] = COSTS.map(c => ({ ...c, percentage: (c.cost / 1100) * 100 }));

// The daily breakdown meets CloudFront first, and CloudFront tops day one.
const DAYS: readonly BarDay[] = [
  { date: '2026-03-01', total: 260, breakdown: { CloudFront: 200, S3: 50, Lambda: 10 } },
  { date: '2026-03-02', total: 840, breakdown: { Lambda: 90, EC2: 500, S3: 150, CloudFront: 100 } },
];

const LINES: readonly LineSeries[] = ['Lambda', 'S3', 'CloudFront', 'EC2'].map(name => ({
  name,
  points: DAYS.map(d => ({ date: d.date, cost: d.breakdown[name] ?? 0 })),
}));

function renderIn(palette: PaletteType, ui: React.ReactElement): HTMLElement {
  return render(<PaletteProvider palette={palette}>{ui}</PaletteProvider>).container;
}

/** A color as the DOM spells it, so hex, rgb and rgba compare equal. */
function normalized(color: string | null | undefined): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = color ?? '';
  return probe.style.backgroundColor;
}

function swatch(root: HTMLElement, name: string, selector: string): HTMLElement {
  const label = within(root).getByText(name);
  const dot = label.parentElement?.querySelector(selector);
  if (!(dot instanceof HTMLElement)) throw new Error(`no swatch beside ${name}`);
  return dot;
}

async function pieColors(palette: PaletteType, slices: readonly PieSlice[] = SLICES): Promise<Map<string, string>> {
  const root = renderIn(palette, <PieChart data={slices} title="By service" />);
  await waitFor(() => { expect(root.querySelectorAll('svg path')).toHaveLength(slices.length); });
  return new Map(slices.map(s => [s.name, normalized(swatch(root, s.name, 'span.inline-block').style.backgroundColor)]));
}

function stackedBarColors(palette: PaletteType, days: readonly BarDay[] = DAYS): Map<string, string> {
  const root = renderIn(palette, <StackedBarChart days={days} />);
  const lastBar = [...root.querySelectorAll('.group.relative')].at(-1);
  if (lastBar === undefined) throw new Error('no bars');
  fireEvent.mouseEnter(lastBar);
  const tip = within(root).getByText(/^Total:/).closest('.min-w-\\[280px\\]');
  if (!(tip instanceof HTMLElement)) throw new Error('no tooltip');
  const names = Object.keys(days.at(-1)?.breakdown ?? {});
  return new Map(names.map(name => [name, normalized(swatch(tip, name, 'span.rounded-full').style.backgroundColor)]));
}

async function lineColors(palette: PaletteType): Promise<Map<string, string>> {
  const root = renderIn(palette, <LineChart series={LINES} />);
  await waitFor(() => { expect(root.querySelectorAll('path.visx-linepath')).toHaveLength(LINES.length); });
  return new Map(NAMES.map(name => [name, normalized(swatch(root, name, 'span.inline-block').style.backgroundColor)]));
}

async function topNColors(palette: PaletteType): Promise<Map<string, string>> {
  const shuffled = [COSTS[2], COSTS[0], COSTS[3], COSTS[1]].filter(c => c !== undefined);
  const root = renderIn(palette, <TopNBarChart data={shuffled.map(c => ({ ...c, percentage: 0 }))} title="Top services" />);
  await waitFor(() => { expect(root.querySelectorAll('li')).toHaveLength(COSTS.length); });
  return new Map(NAMES.map((name) => {
    const fill = within(root).getByTitle(new RegExp(`^${name} — `)).querySelector('.rounded-sm');
    if (!(fill instanceof HTMLElement)) throw new Error(`no bar for ${name}`);
    return [name, normalized(fill.style.backgroundColor)];
  }));
}

async function treemapColors(palette: PaletteType): Promise<Map<string, string>> {
  const root = renderIn(palette, <TreemapChart data={[...COSTS].reverse()} />);
  await waitFor(() => { expect(root.querySelectorAll('svg rect')).toHaveLength(COSTS.length); });
  return new Map(NAMES.map((name) => {
    const rect = root.querySelector(`rect[data-cell="${name}"]`);
    return [name, normalized(rect?.getAttribute('fill'))];
  }));
}

describe('series colors across widgets', () => {
  it.each([
    { palette: 'standard' as const, colors: PALETTE_STANDARD },
    { palette: 'colorblind' as const, colors: PALETTE_COLORBLIND },
  ])('paints each series alike in every chart ($palette)', async ({ palette, colors }) => {
    const pie = await pieColors(palette);

    expect(stackedBarColors(palette)).toEqual(pie);
    expect(await lineColors(palette)).toEqual(pie);
    expect(await topNColors(palette)).toEqual(pie);
    expect(await treemapColors(palette)).toEqual(pie);

    // EC2, the costliest, keeps the slot its name hashes to (CloudFront's
    // too, on the standard palette); the four series get four colors.
    expect(pie.get('EC2')).toBe(normalized(colors[hashSeriesName('EC2') % colors.length]));
    expect(new Set(pie.values()).size).toBe(NAMES.length);
  });

  it('dims the series past the palette alike in the pie and the stacked bar', async () => {
    // Twelve services: the two cheapest rank past the ten standard colors.
    const services = Array.from({ length: 12 }, (_, i) => ({ name: `svc-${String(i)}`, cost: 1200 - i * 100 }));
    const slices = services.map(s => ({ ...s, percentage: 0 }));
    // Listed cheapest first, as a breakdown can be.
    const days: readonly BarDay[] = [{
      date: '2026-03-01',
      total: services.reduce((sum, s) => sum + s.cost, 0),
      breakdown: Object.fromEntries([...services].reverse().map(s => [s.name, s.cost])),
    }];

    const pie = await pieColors('standard', slices);
    expect(stackedBarColors('standard', days)).toEqual(pie);
    for (const s of services.slice(10)) expect(pie.get(s.name)).toMatch(/^rgba\(.*, 0\.5\)$/);
    for (const s of services.slice(0, 10)) expect(pie.get(s.name)).toMatch(/^rgb\(/);
  });
});
