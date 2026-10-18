// A series wears the color its name hashes to, so the same entity (a service,
// a team) keeps one color across every widget, whatever each widget's ranking.
// Hashing means any two palette colors can end up side by side, so every PAIR
// must stay distinguishable, not just neighbouring slots (palette.test.ts).
// Distance is OKLab ΔE ×100; 15 is the usual floor for telling two marks
// apart. Twenty colors is about as many as a dark surface fits: these keep
// every pair at ΔE >= 14.5 while staying visible on the light theme too.
// Past 20, pairs fall under 14 whatever the colors.
export const PALETTE_STANDARD: readonly string[] = [
  '#195fd9', '#137f1f', '#f8a4ae', '#7923fe', '#fb86fc',
  '#2ab301', '#c16c99', '#1ddbfa', '#fc19c4', '#2bb69d',
  '#af1497', '#a3abf0', '#f1113e', '#1a95d8', '#fa7926',
  '#9471ed', '#f1bc25', '#a74a04', '#c715ff', '#a0932d',
];

// Red-green color blindness flattens hue, so these twelve are told apart
// mostly by lightness and the blue-yellow axis: every pair stays at ΔE >= 8.6
// under protanopia and deuteranopia, and >= 16 for everyone else.
export const PALETTE_COLORBLIND: readonly string[] = [
  '#3a49fc', '#0db98e', '#d52f4a', '#96c0fe', '#357518', '#48fbf6',
  '#be6db7', '#6ae72c', '#2291f8', '#e4e495', '#a019c1', '#cf9d22',
];

/** The pie's folded remainder, and the fallback when a palette is empty. */
export const OTHER_COLOR = '#374151';

/** Series ranked past the palette. Every palette color keeps clear of it, so
 *  a minor series never passes for a top one. */
export const MINOR_COLOR = '#6b7280';

export type PaletteType = 'standard' | 'colorblind';

/** A series and what it cost over the chart's range. */
export interface SeriesCost {
  readonly name: string;
  readonly cost: number;
}

/** A series' color, by name. */
export type SeriesColors = (name: string) => string;

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

/** A cost in whole cents for ranking. The pie gets one SQL SUM over the range
 *  and the stacked bar adds up per-day sums: equal spend can differ in the
 *  last float bits, which must not reorder a tie. A non-finite cost ranks last. */
function rankCents(cost: number): number {
  return Number.isFinite(cost) ? Math.round(cost * 100) : Number.NEGATIVE_INFINITY;
}

function byCostThenName(a: SeriesCost, b: SeriesCost): number {
  const [ca, cb] = [rankCents(a.cost), rankCents(b.cost)];
  if (ca !== cb) return cb > ca ? 1 : -1;
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/** Colors a chart's series. Each name prefers the slot it hashes to; when a
 *  costlier series already holds that slot, it takes the next free one, so a
 *  chart's top `palette.length` series always get distinct colors. Series
 *  ranked past that are drawn in MINOR_COLOR.
 *
 *  The result depends only on the names and their costs, never on the order
 *  a chart lists them in, and a series' color depends only on the series that
 *  outrank it. So every widget over the same range and filters agrees: a pie
 *  of the top 50 and a line chart of the top 6 paint their top 6 alike. */
export function assignSeriesColors(series: readonly SeriesCost[], palette: readonly string[]): SeriesColors {
  const size = palette.length;
  if (size === 0) return () => OTHER_COLOR;

  const colors = new Map<string, string>();
  const taken = new Set<number>();
  for (const { name } of [...series].sort(byCostThenName)) {
    if (colors.has(name)) continue;
    if (taken.size === size) {
      colors.set(name, MINOR_COLOR);
      continue;
    }
    let slot = hashSeriesName(name) % size;
    while (taken.has(slot)) slot = (slot + 1) % size;
    taken.add(slot);
    colors.set(name, palette[slot] ?? OTHER_COLOR);
  }
  return (name) => colors.get(name) ?? MINOR_COLOR;
}

/** A fixed role color, for marks that are not series (price-volume's volume
 *  and rate): slot `index` of the palette. */
export function getColor(index: number, palette: readonly string[] = PALETTE_STANDARD): string {
  return palette[index] ?? OTHER_COLOR;
}

export function getActivePalette(type: PaletteType = 'standard'): readonly string[] {
  return type === 'colorblind' ? PALETTE_COLORBLIND : PALETTE_STANDARD;
}
