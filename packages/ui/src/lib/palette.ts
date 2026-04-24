export const PALETTE_STANDARD: readonly string[] = [
  '#10b981', '#06b6d4', '#f59e0b', '#8b5cf6',
  '#f43e5c', '#3b82f6', '#f97316', '#14b8a6',
];

export const PALETTE_COLORBLIND: readonly string[] = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#F0E442',
];

const PALETTE_FALLBACK = '#374151';

export function getColor(index: number, palette: readonly string[] = PALETTE_STANDARD): string {
  return palette[index % palette.length] ?? PALETTE_FALLBACK;
}

type PaletteType = 'standard' | 'colorblind';

export function getActivePalette(type: PaletteType = 'standard'): readonly string[] {
  return type === 'colorblind' ? PALETTE_COLORBLIND : PALETTE_STANDARD;
}
