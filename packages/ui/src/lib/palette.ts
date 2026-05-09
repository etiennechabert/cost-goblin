// Curated colors for the first N series in any chart. Sized at 16 so that the
// common case (a stacked bar broken down by a single dimension) gets distinct,
// designer-picked hues. Anything beyond falls back to algorithmic generation
// below — which never collides because the golden-angle step ensures every
// new hue is maximally distant from prior ones.
export const PALETTE_STANDARD: readonly string[] = [
  '#10b981', '#06b6d4', '#f59e0b', '#8b5cf6',
  '#f43e5c', '#3b82f6', '#f97316', '#14b8a6',
  '#a855f7', '#ec4899', '#22d3ee', '#84cc16',
  '#eab308', '#6366f1', '#ef4444', '#0ea5e9',
];

// Okabe-Ito palette extended with safe variants. Each row is one "family":
// keeping families together so adjacent indices in a small chart still read as
// distinct hues to a colorblind viewer.
export const PALETTE_COLORBLIND: readonly string[] = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#F0E442', '#000000',
  '#5DADE2', '#F1948A', '#48C9B0', '#AF7AC5',
  '#F39C12', '#1F618D', '#7FB3D5', '#A9DFBF',
];

const PALETTE_FALLBACK = '#374151';

// Golden-angle step in degrees. Each subsequent index advances the hue by this
// amount mod 360, which is the irrational sweet spot that maximizes visual
// separation between colors regardless of how many we end up generating.
const GOLDEN_ANGLE = 137.508;

export type PaletteType = 'standard' | 'colorblind';

/** Extended HSL fallback for indices past the curated palette. Deterministic
 *  for a given (index, palette.length) so the same series always gets the
 *  same color across renders. Uses the curated palette length as the rotation
 *  start so the first generated hue doesn't collide with the last curated one. */
function generateColor(index: number, paletteLength: number): string {
  const hue = ((index - paletteLength) * GOLDEN_ANGLE) % 360;
  const positiveHue = hue < 0 ? hue + 360 : hue;
  // Alternate slightly between two lightness/saturation pairs so neighbouring
  // generated colors don't all read as the same brightness.
  const isOdd = (index - paletteLength) % 2 === 1;
  const saturation = isOdd ? 55 : 65;
  const lightness = isOdd ? 60 : 50;
  return `hsl(${positiveHue.toFixed(1)}, ${String(saturation)}%, ${String(lightness)}%)`;
}

export function getColor(index: number, palette: readonly string[] = PALETTE_STANDARD): string {
  if (index < 0) return PALETTE_FALLBACK;
  const curated = palette[index];
  if (curated !== undefined) return curated;
  return generateColor(index, palette.length);
}

export function getActivePalette(type: PaletteType = 'standard'): readonly string[] {
  return type === 'colorblind' ? PALETTE_COLORBLIND : PALETTE_STANDARD;
}
