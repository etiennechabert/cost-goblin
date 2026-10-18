import { describe, expect, it } from 'vitest';
import {
  MINOR_COLOR,
  OTHER_COLOR,
  PALETTE_COLORBLIND,
  PALETTE_STANDARD,
  assignSeriesColors,
  hashSeriesName,
} from '../lib/palette.js';
import type { SeriesCost } from '../lib/palette.js';

const P = PALETTE_STANDARD.length;

function slotOf(name: string, size = P): number {
  return hashSeriesName(name) % size;
}

function color(palette: readonly string[], slot: number): string {
  const c = palette[slot];
  if (c === undefined) throw new Error(`no slot ${String(slot)}`);
  return c;
}

/** `count` series named `${prefix}-0…`, costliest first. */
function series(prefix: string, count: number): SeriesCost[] {
  return Array.from({ length: count }, (_, i) => ({ name: `${prefix}-${String(i)}`, cost: 1000 - i }));
}

// OKLab ΔE ×100 (Björn Ottosson's OKLab; CVD via Machado et al. 2009 at
// severity 1.0), the scale the palette floors are stated in.
type Rgb = readonly [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];

function linearRgb(hex: string): Rgb {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return [r, g, b];
}

function apply(m: Matrix, [r, g, b]: Rgb): Rgb {
  const row = ([x, y, z]: Rgb): number => Math.min(1, Math.max(0, x * r + y * g + z * b));
  return [row(m[0]), row(m[1]), row(m[2])];
}

function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const PROTAN: Matrix = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]];
const DEUTAN: Matrix = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]];

function deltaE(a: string, b: string, cvd?: Matrix): number {
  const see = (hex: string): Rgb => oklab(cvd === undefined ? linearRgb(hex) : apply(cvd, linearRgb(hex)));
  const [la, aa, ba] = see(a);
  const [lb, ab, bb] = see(b);
  return 100 * Math.hypot(la - lb, aa - ab, ba - bb);
}

function worstPair(palette: readonly string[], distance: (a: string, b: string) => number): number {
  let worst = Number.POSITIVE_INFINITY;
  palette.forEach((a, i) => { palette.slice(i + 1).forEach((b) => { worst = Math.min(worst, distance(a, b)); }); });
  return worst;
}

function contrast(a: string, b: string): number {
  const lum = (hex: string): number => { const [r, g, bl] = linearRgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

// The dark theme's card: bg-secondary (#171717) at 50% over bg-primary (#0a0a0b).
const DARK_CARD = '#111111';

describe('hashSeriesName', () => {
  it('maps a name to the same slot on every run', () => {
    // Changing the hash repaints every chart for every user: pin it.
    expect(['BigQuery', 'Vertex AI', 'Cloud Run', 'Gemini API', 'Compute Engine'].map(n => slotOf(n))).toEqual([11, 16, 10, 12, 6]);
  });

  it.each([PALETTE_STANDARD, PALETTE_COLORBLIND])('spreads names evenly over a %#-th palette', (palette) => {
    const counts = new Array<number>(palette.length).fill(0);
    for (let i = 0; i < 1000; i++) {
      const slot = slotOf(`service-${String(i)}`, palette.length);
      counts[slot] = (counts[slot] ?? 0) + 1;
    }
    const mean = 1000 / palette.length;
    for (const n of counts) {
      expect(n).toBeGreaterThan(mean * 0.65);
      expect(n).toBeLessThan(mean * 1.35);
    }
  });

  it('lets every bit of a name pick the slot, not only the low bits of each character', () => {
    // '1' 'A' 'Q' 'a' 'q' share their low four bits: plain FNV-1a puts all
    // five names on one slot of any power-of-two palette.
    const slots = ['1', 'A', 'Q', 'a', 'q'].map(c => slotOf(`team-${c}`, 8));
    expect(new Set(slots).size).toBeGreaterThan(1);
  });
});

describe('assignSeriesColors', () => {
  it('colors a series by its name and cost, not by where the chart lists it', () => {
    const pie = [{ name: 'BigQuery', cost: 18_200 }, { name: 'Vertex AI', cost: 16_300 }, { name: 'Cloud Run', cost: 9000 }];
    // A daily breakdown lists its keys in first-seen order instead.
    const bars = [{ name: 'Cloud Run', cost: 9000 }, { name: 'Vertex AI', cost: 16_300 }, { name: 'BigQuery', cost: 18_200 }];
    const fromPie = assignSeriesColors(pie, PALETTE_STANDARD);
    const fromBars = assignSeriesColors(bars, PALETTE_STANDARD);
    for (const name of ['BigQuery', 'Vertex AI', 'Cloud Run']) expect(fromBars(name)).toBe(fromPie(name));
    expect(fromPie('BigQuery')).toBe(color(PALETTE_STANDARD, slotOf('BigQuery')));
  });

  it('moves the cheaper of two series that hash to one slot to the next free slot', () => {
    // EC2 and SNS both hash to slot 12.
    expect(slotOf('EC2')).toBe(slotOf('SNS'));
    const slot = slotOf('EC2');
    const ec2First = assignSeriesColors([{ name: 'EC2', cost: 500 }, { name: 'SNS', cost: 300 }], PALETTE_STANDARD);
    expect(ec2First('EC2')).toBe(color(PALETTE_STANDARD, slot));
    expect(ec2First('SNS')).toBe(color(PALETTE_STANDARD, (slot + 1) % P));

    // The slot goes to whichever costs more over the chart's range.
    const snsFirst = assignSeriesColors([{ name: 'EC2', cost: 300 }, { name: 'SNS', cost: 500 }], PALETTE_STANDARD);
    expect(snsFirst('SNS')).toBe(color(PALETTE_STANDARD, slot));
  });

  it('gives each of the top series its own color, one per palette slot', () => {
    const top = series('svc', P);
    const colors = assignSeriesColors(top, PALETTE_STANDARD);
    expect(new Set(top.map(s => colors(s.name)))).toEqual(new Set(PALETTE_STANDARD));
  });

  it("keeps a chart's colors when another chart shows more of the same ranking", () => {
    const all = series('svc', 40);
    const many = assignSeriesColors(all, PALETTE_STANDARD);
    const few = assignSeriesColors(all.slice(0, 6), PALETTE_STANDARD);
    for (const s of all.slice(0, 6)) expect(few(s.name)).toBe(many(s.name));
  });

  it('draws series ranked past the palette in the minor gray', () => {
    const all = series('svc', P + 5);
    const colors = assignSeriesColors(all, PALETTE_STANDARD);
    for (const s of all.slice(P)) expect(colors(s.name)).toBe(MINOR_COLOR);
  });

  it('breaks a cost tie by name, so equal series color alike in every chart', () => {
    const a = assignSeriesColors([{ name: 'SNS', cost: 100 }, { name: 'EC2', cost: 100 }], PALETTE_STANDARD);
    const b = assignSeriesColors([{ name: 'EC2', cost: 100 }, { name: 'SNS', cost: 100 }], PALETTE_STANDARD);
    expect(b('EC2')).toBe(a('EC2'));
    expect(b('SNS')).toBe(a('SNS'));
    // 'EC2' sorts first, so it keeps the shared slot.
    expect(a('EC2')).toBe(color(PALETTE_STANDARD, slotOf('EC2')));
  });

  it('ranks spend that differs only in float noise as a tie, broken by name', () => {
    // One widget's SQL SUM and another's added-up daily sums of the same $73.
    const pie = assignSeriesColors([{ name: 'SNS', cost: 73 }, { name: 'EC2', cost: 72.999_999_999_999_99 }], PALETTE_STANDARD);
    const bars = assignSeriesColors([{ name: 'SNS', cost: 72.999_999_999_999_99 }, { name: 'EC2', cost: 73.000_000_000_000_01 }], PALETTE_STANDARD);
    expect(bars('EC2')).toBe(pie('EC2'));
    expect(pie('EC2')).toBe(color(PALETTE_STANDARD, slotOf('EC2')));
  });

  it('ranks a series whose cost is not a number last', () => {
    const colors = assignSeriesColors([{ name: 'EC2', cost: Number.NaN }, { name: 'SNS', cost: 1 }], PALETTE_STANDARD);
    // SNS ranks first and takes the slot both names hash to.
    expect(colors('SNS')).toBe(color(PALETTE_STANDARD, slotOf('SNS')));
    expect(colors('EC2')).toBe(color(PALETTE_STANDARD, (slotOf('EC2') + 1) % P));
  });

  it('colors a name it was not ranked with as a minor series', () => {
    const colors = assignSeriesColors([{ name: 'EC2', cost: 1 }], PALETTE_STANDARD);
    expect(colors('S3')).toBe(MINOR_COLOR);
  });

  it('assigns the colorblind palette the same way', () => {
    const top = series('svc', PALETTE_COLORBLIND.length);
    const colors = assignSeriesColors(top, PALETTE_COLORBLIND);
    expect(new Set(top.map(s => colors(s.name)))).toEqual(new Set(PALETTE_COLORBLIND));
  });

  it('falls back to the Other color without a palette', () => {
    expect(assignSeriesColors([{ name: 'EC2', cost: 1 }], [])('EC2')).toBe(OTHER_COLOR);
  });
});

describe('chart palettes', () => {
  // A name can hash to any slot, so any two colors can share a chart: every
  // pair has to stay apart, not just neighbouring slots, and apart from the
  // grays of minor series and the pie's Other. 15 is the usual floor; twenty
  // standard colors that stay visible on the light theme top out at 14.5.
  it.each([
    { name: 'standard', palette: PALETTE_STANDARD, floor: 14 },
    { name: 'colorblind', palette: PALETTE_COLORBLIND, floor: 15 },
  ])('keeps every pair of $name colors, grays included, distinguishable', ({ palette, floor }) => {
    expect(worstPair([...palette, MINOR_COLOR, OTHER_COLOR], (a, b) => deltaE(a, b))).toBeGreaterThanOrEqual(floor);
  });

  it('keeps every pair of colorblind colors apart under protanopia and deuteranopia', () => {
    const cvd = (a: string, b: string): number => Math.min(deltaE(a, b, PROTAN), deltaE(a, b, DEUTAN));
    expect(worstPair([...PALETTE_COLORBLIND, MINOR_COLOR, OTHER_COLOR], cvd)).toBeGreaterThanOrEqual(8);
  });

  it.each([
    { name: 'standard', palette: PALETTE_STANDARD },
    { name: 'colorblind', palette: PALETTE_COLORBLIND },
  ])('keeps every $name color visible on the dark card', ({ palette }) => {
    for (const c of palette) expect(contrast(c, DARK_CARD)).toBeGreaterThanOrEqual(3);
  });
});
