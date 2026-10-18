import type { UIPreferences } from '@costgoblin/core/browser';

// A series wears the color its name hashes to, so the same entity (a service,
// a team) keeps one color across every widget, whatever each widget's ranking.
// Hashing means any two palette colors can end up side by side, so every PAIR
// must stay distinguishable, not just neighbouring slots (palette.test.ts).
// Distance is OKLab ΔE ×100; 15 is the usual floor for telling two marks
// apart. Each palette has a step per theme: slot k keeps its hue family (within about
// 25°) on both cards, so a series looks related when the theme flips.
//
// Twenty colors is about as many as a dark card fits: every pair at ΔE >= 14.5.
// Past 20, pairs fall under 14 whatever the colors.
export const PALETTE_STANDARD: readonly string[] = [
  '#195fd9', '#137f1f', '#f8a4ae', '#7923fe', '#fb86fc',
  '#2ab301', '#c16c99', '#1ddbfa', '#fc19c4', '#2bb69d',
  '#af1497', '#a3abf0', '#f1113e', '#1a95d8', '#fa7926',
  '#9471ed', '#f1bc25', '#a74a04', '#c715ff', '#a0932d',
];

// The light card leaves only the darker half of the gamut (3:1 on white), so
// the same twenty sit closer together: every pair at ΔE >= 13.
export const PALETTE_STANDARD_LIGHT: readonly string[] = [
  '#4e6afd', '#0d9414', '#f9508c', '#5f24b8', '#c76ccf',
  '#306d3c', '#ca0c73', '#0b96d6', '#9746ac', '#3ba088',
  '#8c0669', '#2c5dae', '#b96365', '#1235ee', '#ac0312',
  '#d318fc', '#7c4b02', '#ea0707', '#901bf8', '#a0932d',
];

// Red-green color blindness flattens hue, so these twelve are told apart
// mostly by lightness and the blue-yellow axis. Chosen for both themes at once:
// on either card every pair stays at ΔE >= 7.9 under protanopia and
// deuteranopia, and >= 14.7 for everyone else.
export const PALETTE_COLORBLIND: readonly string[] = [
  '#3947fb', '#fea47c', '#35cd0e', '#c67ea3', '#fedc67', '#8742b5',
  '#8d9c23', '#da1c66', '#8ac3fc', '#a84811', '#1a95d8', '#ef58fe',
];

export const PALETTE_COLORBLIND_LIGHT: readonly string[] = [
  '#1387fe', '#7f1522', '#399f6e', '#7f3a86', '#c57d08', '#3f0199',
  '#197502', '#ce70ad', '#3c01fe', '#d41101', '#2055b3', '#eb2ee4',
];

// The standard twenty at full saturation, slot by slot the same hue family
// (within 20°). Punchier, so pairs sit a little closer: >= 12 on the dark card,
// >= 13 on the light one.
export const PALETTE_VIVID: readonly string[] = [
  '#1299fd', '#27f40c', '#c2287a', '#9306fb', '#ff03fc',
  '#05c718', '#c763c0', '#1ddbfa', '#fe70a3', '#08f6a8',
  '#f80aab', '#9868fc', '#fb0756', '#0367f8', '#c8340e',
  '#d48eff', '#fea402', '#fd6324', '#c204cf', '#c5e620',
];

export const PALETTE_VIVID_LIGHT: readonly string[] = [
  '#0a47fd', '#04a612', '#ca02ba', '#b055fc', '#8c47a0',
  '#0e5108', '#ff03fc', '#1499da', '#fd122e', '#219e87',
  '#fc399c', '#2100c4', '#c4085e', '#0556a9', '#8a011e',
  '#660597', '#df741c', '#af4705', '#8306e5', '#177b26',
];

/** The pie's folded remainder, and the fallback when a palette is empty. */
export const OTHER_COLOR = '#374151';

/** Series ranked past the palette. Every palette color keeps clear of it, so
 *  a minor series never passes for a top one. */
export const MINOR_COLOR = '#6b7280';

/** The user's palette choice and the app theme, as UIPreferences stores them. */
export type PaletteType = UIPreferences['palette'];
export type PaletteTheme = UIPreferences['theme'];

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
  for (const ch of name) {
    h ^= ch.codePointAt(0) ?? 0;
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

// A palette of twenty holds several shades of each hue family, and ΔE rates a
// purple and a bright purple as distinct when people read them as one color.
// So the assignment keeps a chart's top series this far apart under a
// distance that counts hue differences twice (familyDistance), and only falls
// back to a second shade of a family once no free color is that far away.
// Shades of one family measure 13-19 there; at 22 the top 7 series of any
// chart (6 on the light card, 3 to 4 colorblind) get different families.
const DISTINCT = 22;

type Rgb = readonly [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];

// Protanopia and deuteranopia at severity 1 (Machado, Oliveira & Fernandes
// 2009), on linear sRGB.
const PROTAN: Matrix = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]];
const DEUTAN: Matrix = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]];

function linearRgb(hex: string): Rgb {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return [r, g, b];
}

function simulate(m: Matrix, [r, g, b]: Rgb): Rgb {
  const row = ([x, y, z]: Rgb): number => Math.min(1, Math.max(0, x * r + y * g + z * b));
  return [row(m[0]), row(m[1]), row(m[2])];
}

/** Björn Ottosson's OKLab. */
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

/** OKLab distance ×100 with the hue difference counted twice: two shades of
 *  one hue (a purple and a bright purple) land near 16, a purple and a blue
 *  near 33. */
function familyDistance([l1, a1, b1]: Rgb, [l2, a2, b2]: Rgb): number {
  const dC = Math.hypot(a1, b1) - Math.hypot(a2, b2);
  const dH2 = Math.max(0, (a1 - a2) ** 2 + (b1 - b2) ** 2 - dC ** 2);
  return 100 * Math.sqrt((l1 - l2) ** 2 + dC ** 2 + 4 * dH2);
}

function labDistance([l1, a1, b1]: Rgb, [l2, a2, b2]: Rgb): number {
  return 100 * Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** How apart each pair of a palette's colors reads. For a colorblind palette,
 *  also as protanopes and deuteranopes see it (x2, so ΔE 11 meets DISTINCT). */
function pairDistances(palette: readonly string[], colorblind: boolean): readonly (readonly number[])[] {
  const seen = palette.map(linearRgb);
  const normal = seen.map(oklab);
  const protan = seen.map(c => oklab(simulate(PROTAN, c)));
  const deutan = seen.map(c => oklab(simulate(DEUTAN, c)));
  return normal.map((a, i) => normal.map((b, j) => {
    const family = familyDistance(a, b);
    if (!colorblind) return family;
    const cvd = Math.min(labDistance(protan[i] ?? a, protan[j] ?? b), labDistance(deutan[i] ?? a, deutan[j] ?? b));
    return Math.min(family, 2 * cvd);
  }));
}

const distanceCache = new Map<string, readonly (readonly number[])[]>();

function distancesOf(palette: readonly string[], colorblind: boolean): readonly (readonly number[])[] {
  const key = `${String(colorblind)}:${palette.join(',')}`;
  const cached = distanceCache.get(key);
  if (cached !== undefined) return cached;
  const computed = pairDistances(palette, colorblind);
  distanceCache.set(key, computed);
  return computed;
}

/** The first free slot from `preferred` on whose color stays DISTINCT from
 *  every color the chart already uses; when none does, the free slot farthest
 *  from them (the first one, on a tie). */
function pickSlot(preferred: number, used: readonly number[], distances: readonly (readonly number[])[], size: number): number {
  let farthest = -1;
  let farthestDistance = -1;
  for (let i = 0; i < size; i++) {
    const slot = (preferred + i) % size;
    if (used.includes(slot)) continue;
    const nearest = used.reduce((m, u) => Math.min(m, distances[slot]?.[u] ?? 0), Number.POSITIVE_INFINITY);
    if (nearest >= DISTINCT) return slot;
    if (nearest > farthestDistance) {
      farthest = slot;
      farthestDistance = nearest;
    }
  }
  return farthest;
}

/** Colors a chart's series. Each name prefers the slot it hashes to. A slot
 *  whose color a costlier series already holds, or one too close to a color
 *  the chart already uses (two shades of purple), passes to the next slot; so
 *  a chart's top series get clearly different colors, then the rest get the
 *  remaining shades, one slot each. Series ranked past the palette are drawn
 *  in MINOR_COLOR.
 *
 *  The result depends only on the names and their costs, never on the order
 *  a chart lists them in, and a series' color depends only on the series that
 *  outrank it. So every widget over the same range and filters agrees: a pie
 *  of the top 50 and a line chart of the top 6 paint their top 6 alike. */
export function assignSeriesColors(
  series: readonly SeriesCost[],
  palette: readonly string[],
  options: { readonly colorblind?: boolean } = {},
): SeriesColors {
  const size = palette.length;
  if (size === 0) return () => OTHER_COLOR;
  const distances = distancesOf(palette, options.colorblind === true);

  const colors = new Map<string, string>();
  const used: number[] = [];
  for (const { name } of [...series].sort(byCostThenName)) {
    if (colors.has(name)) continue;
    if (used.length === size) {
      colors.set(name, MINOR_COLOR);
      continue;
    }
    const slot = pickSlot(hashSeriesName(name) % size, used, distances, size);
    used.push(slot);
    colors.set(name, palette[slot] ?? OTHER_COLOR);
  }
  return (name) => colors.get(name) ?? MINOR_COLOR;
}

/** A fixed role color, for marks that are not series (price-volume's volume
 *  and rate): slot `index` of the palette. */
export function getColor(index: number, palette: readonly string[] = PALETTE_STANDARD): string {
  return palette[index] ?? OTHER_COLOR;
}

const PALETTES: Readonly<Record<PaletteType, Readonly<Record<PaletteTheme, readonly string[]>>>> = {
  standard: { dark: PALETTE_STANDARD, light: PALETTE_STANDARD_LIGHT },
  vivid: { dark: PALETTE_VIVID, light: PALETTE_VIVID_LIGHT },
  colorblind: { dark: PALETTE_COLORBLIND, light: PALETTE_COLORBLIND_LIGHT },
};

export function getActivePalette(type: PaletteType = 'standard', theme: PaletteTheme = 'dark'): readonly string[] {
  return PALETTES[type][theme];
}
