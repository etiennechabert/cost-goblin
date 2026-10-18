// A series wears the color its name hashes to, so the same entity (a service,
// a team) keeps one color across every widget, whatever each widget's ranking.
// Hashing means any two palette colors can end up side by side, so every PAIR
// must stay distinguishable, not just neighbouring slots: both palettes keep
// every pair at OKLab ΔE >= 15 (palette.test.ts). That floor is what sizes
// them. Past ~10 colors on the dark surface, some pair always falls under it.
export const PALETTE_STANDARD: readonly string[] = [
  '#10b981', '#6366f1', '#fdba74', '#c026d3', '#d97706',
  '#0ea5e9', '#e11d48', '#c4b5fd', '#a3e635', '#f472b6',
];

// Okabe-Ito without its black, which is invisible on the dark card (1.1:1).
// Every pair also stays at ΔE >= 7.6 under protanopia and deuteranopia.
export const PALETTE_COLORBLIND: readonly string[] = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#F0E442',
];

/** The pie's folded remainder, and the fallback when a palette is empty. */
export const OTHER_COLOR = '#374151';

export type PaletteType = 'standard' | 'colorblind';

/** A series and what it cost over the chart's range. */
export interface SeriesCost {
  readonly name: string;
  readonly cost: number;
}

/** A series' color, by name. */
export type SeriesColors = (name: string) => string;

// Opacity of a series ranked past the palette: its own hue, dimmed, so the
// long tail stays colored but reads as minor on either theme's surface.
const MINOR_ALPHA = 0.5;

/** 32-bit FNV-1a of the name, then murmur3's fmix32 finalizer. FNV-1a's low
 *  bits depend only on the low bits of each character, so without the mix a
 *  power-of-two palette would put "team-1" and "team-A" on the same slot. */
export function hashSeriesName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function dim(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(MINOR_ALPHA)})`;
}

function byCostThenName(a: SeriesCost, b: SeriesCost): number {
  if (a.cost !== b.cost) return b.cost - a.cost;
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/** Colors a chart's series. Each name prefers the slot it hashes to; when a
 *  costlier series already holds that slot, it takes the next free one, so a
 *  chart's top `palette.length` series always get distinct colors. Series
 *  ranked past that keep their hashed hue, dimmed.
 *
 *  The result depends only on the names and their costs, never on the order
 *  a chart lists them in, and a series' color depends only on the series that
 *  outrank it. So every widget over the same range and filters agrees: a pie
 *  of the top 50 and a line chart of the top 6 paint their top 6 alike. */
export function assignSeriesColors(series: readonly SeriesCost[], palette: readonly string[]): SeriesColors {
  const size = palette.length;
  if (size === 0) return () => OTHER_COLOR;
  const hashed = (name: string): string => palette[hashSeriesName(name) % size] ?? OTHER_COLOR;

  const colors = new Map<string, string>();
  const taken = new Set<number>();
  for (const { name } of [...series].sort(byCostThenName)) {
    if (colors.has(name)) continue;
    if (taken.size === size) {
      colors.set(name, dim(hashed(name)));
      continue;
    }
    let slot = hashSeriesName(name) % size;
    while (taken.has(slot)) slot = (slot + 1) % size;
    taken.add(slot);
    colors.set(name, palette[slot] ?? OTHER_COLOR);
  }
  return (name) => colors.get(name) ?? dim(hashed(name));
}

/** A fixed role color, for marks that are not series (price-volume's volume
 *  and rate): slot `index` of the palette. */
export function getColor(index: number, palette: readonly string[] = PALETTE_STANDARD): string {
  return palette[index] ?? OTHER_COLOR;
}

export function getActivePalette(type: PaletteType = 'standard'): readonly string[] {
  return type === 'colorblind' ? PALETTE_COLORBLIND : PALETTE_STANDARD;
}
