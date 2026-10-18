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
import { MINOR_COLOR, PALETTE_COLORBLIND, PALETTE_COLORBLIND_LIGHT, PALETTE_STANDARD, PALETTE_STANDARD_LIGHT, hashSeriesName } from '../lib/palette.js';
import type { PaletteTheme, PaletteType } from '../lib/palette.js';

// One range's spend, as each widget receives it. EC2 and SNS hash to the same
// standard slot, so the ranking decides which keeps it.
const COSTS = [
  { name: 'EC2', cost: 500 },
  { name: 'SNS', cost: 300 },
  { name: 'S3', cost: 200 },
  { name: 'Lambda', cost: 100 },
];
const NAMES = COSTS.map(c => c.name);

const SLICES: readonly PieSlice[] = COSTS.map(c => ({ ...c, percentage: (c.cost / 1100) * 100 }));

// The daily breakdown meets SNS first, and SNS tops day one.
const DAYS: readonly BarDay[] = [
  { date: '2026-03-01', total: 260, breakdown: { SNS: 200, S3: 50, Lambda: 10 } },
  { date: '2026-03-02', total: 840, breakdown: { Lambda: 90, EC2: 500, S3: 150, SNS: 100 } },
];

const LINES: readonly LineSeries[] = ['Lambda', 'S3', 'SNS', 'EC2'].map(name => ({
  name,
  points: DAYS.map(d => ({ date: d.date, cost: d.breakdown[name] ?? 0 })),
}));

/** Which palette a chart renders with: the user's choice and the app theme. */
interface Look {
  readonly palette: PaletteType;
  readonly theme: PaletteTheme;
}

const STANDARD_DARK: Look = { palette: 'standard', theme: 'dark' };

function renderIn({ palette, theme }: Look, ui: React.ReactElement): HTMLElement {
  return render(<PaletteProvider palette={palette} theme={theme}>{ui}</PaletteProvider>).container;
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

async function pieColors(look: Look, slices: readonly PieSlice[] = SLICES): Promise<Map<string, string>> {
  const root = renderIn(look, <PieChart data={slices} title="By service" />);
  await waitFor(() => { expect(root.querySelectorAll('svg path')).toHaveLength(slices.length); });
  return new Map(slices.map(s => [s.name, normalized(swatch(root, s.name, 'span.inline-block').style.backgroundColor)]));
}

function lastBar(root: HTMLElement): Element {
  const bar = [...root.querySelectorAll('.group.relative')].at(-1);
  if (bar === undefined) throw new Error('no bars');
  return bar;
}

/** Read off the last bar's tooltip, which lists up to twelve series. */
function stackedBarColors(look: Look, days: readonly BarDay[] = DAYS): Map<string, string> {
  const root = renderIn(look, <StackedBarChart days={days} />);
  fireEvent.mouseEnter(lastBar(root));
  const tip = within(root).getByText(/^Total:/).closest('.min-w-\\[280px\\]');
  if (!(tip instanceof HTMLElement)) throw new Error('no tooltip');
  const names = Object.keys(days.at(-1)?.breakdown ?? {});
  return new Map(names.map(name => [name, normalized(swatch(tip, name, 'span.rounded-full').style.backgroundColor)]));
}

/** Read off the last bar's segments, which stack costliest first. */
function stackedSegmentColors(look: Look, day: BarDay): Map<string, string> {
  const root = renderIn(look, <StackedBarChart days={[day]} />);
  const segments = [...(lastBar(root).firstElementChild?.children ?? [])];
  const names = Object.entries(day.breakdown).sort((a, b) => b[1] - a[1]).map(([name]) => name);
  return new Map(names.map((name, i) => {
    const seg = segments[i];
    if (!(seg instanceof HTMLElement)) throw new Error(`no segment for ${name}`);
    return [name, normalized(seg.style.backgroundColor)];
  }));
}

async function lineColors(look: Look): Promise<Map<string, string>> {
  const root = renderIn(look, <LineChart series={LINES} />);
  await waitFor(() => { expect(root.querySelectorAll('path.visx-linepath')).toHaveLength(LINES.length); });
  return new Map(NAMES.map(name => [name, normalized(swatch(root, name, 'span.inline-block').style.backgroundColor)]));
}

async function topNColors(look: Look): Promise<Map<string, string>> {
  const shuffled = [COSTS[2], COSTS[0], COSTS[3], COSTS[1]].filter(c => c !== undefined);
  const root = renderIn(look, <TopNBarChart data={shuffled.map(c => ({ ...c, percentage: 0 }))} title="Top services" />);
  await waitFor(() => { expect(root.querySelectorAll('li')).toHaveLength(COSTS.length); });
  return new Map(NAMES.map((name) => {
    const fill = within(root).getByTitle(new RegExp(`^${name} — `)).querySelector('.rounded-sm');
    if (!(fill instanceof HTMLElement)) throw new Error(`no bar for ${name}`);
    return [name, normalized(fill.style.backgroundColor)];
  }));
}

async function treemapColors(look: Look): Promise<Map<string, string>> {
  const root = renderIn(look, <TreemapChart data={[...COSTS].reverse()} />);
  await waitFor(() => { expect(root.querySelectorAll('svg rect')).toHaveLength(COSTS.length); });
  return new Map(NAMES.map((name) => {
    const rect = root.querySelector(`rect[data-cell="${name}"]`);
    return [name, normalized(rect?.getAttribute('fill'))];
  }));
}

const LOOKS: readonly (Look & { readonly colors: readonly string[] })[] = [
  { palette: 'standard', theme: 'dark', colors: PALETTE_STANDARD },
  { palette: 'standard', theme: 'light', colors: PALETTE_STANDARD_LIGHT },
  { palette: 'colorblind', theme: 'dark', colors: PALETTE_COLORBLIND },
  { palette: 'colorblind', theme: 'light', colors: PALETTE_COLORBLIND_LIGHT },
];

describe('series colors across widgets', () => {
  it.each(LOOKS)('paints each series alike in every chart ($palette, $theme theme)', async (look) => {
    const { colors } = look;
    const pie = await pieColors(look);

    expect(stackedBarColors(look)).toEqual(pie);
    expect(await lineColors(look)).toEqual(pie);
    expect(await topNColors(look)).toEqual(pie);
    expect(await treemapColors(look)).toEqual(pie);

    // EC2, the costliest, keeps the slot its name hashes to (SNS's too, on
    // the standard palette); the four series get four colors.
    expect(pie.get('EC2')).toBe(normalized(colors[hashSeriesName('EC2') % colors.length]));
    expect(new Set(pie.values()).size).toBe(NAMES.length);
  });

  it('grays the series past the palette alike in the pie and the stacked bar', async () => {
    // The two cheapest services rank past the standard palette.
    const size = PALETTE_STANDARD.length;
    const services = Array.from({ length: size + 2 }, (_, i) => ({ name: `svc-${String(i)}`, cost: 10_000 - i * 100 }));
    const slices = services.map(s => ({ ...s, percentage: 0 }));
    // Listed cheapest first, as a breakdown can be.
    const day: BarDay = {
      date: '2026-03-01',
      total: services.reduce((sum, s) => sum + s.cost, 0),
      breakdown: Object.fromEntries([...services].reverse().map(s => [s.name, s.cost])),
    };

    const pie = await pieColors(STANDARD_DARK, slices);
    expect(stackedSegmentColors(STANDARD_DARK, day)).toEqual(pie);
    for (const s of services.slice(size)) expect(pie.get(s.name)).toBe(normalized(MINOR_COLOR));
    expect(new Set(services.slice(0, size).map(s => pie.get(s.name))).size).toBe(size);
  });
});
