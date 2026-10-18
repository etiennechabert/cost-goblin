import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { assignSeriesColors, getActivePalette } from '../lib/palette.js';
import type { PaletteTheme, PaletteType, SeriesColors, SeriesCost } from '../lib/palette.js';

interface PaletteContextValue {
  readonly paletteType: PaletteType;
  readonly palette: readonly string[];
}

const PaletteContext = createContext<PaletteContextValue | undefined>(undefined);

interface PaletteProviderProps {
  readonly children: ReactNode;
  readonly palette?: PaletteType;
  /** The app theme: each palette has its own steps for the dark and light card. */
  readonly theme?: PaletteTheme;
}

export function PaletteProvider({ children, palette: paletteType = 'standard', theme = 'dark' }: PaletteProviderProps): React.JSX.Element {
  const value = useMemo<PaletteContextValue>(
    () => ({
      paletteType,
      palette: getActivePalette(paletteType, theme),
    }),
    [paletteType, theme],
  );

  return (
    <PaletteContext.Provider value={value}>
      {children}
    </PaletteContext.Provider>
  );
}

export function usePalette(): PaletteContextValue {
  const ctx = useContext(PaletteContext);
  if (ctx === undefined) {
    throw new Error('usePalette must be used within a PaletteProvider');
  }
  return ctx;
}

/** The active palette's colors for a chart's series (see assignSeriesColors).
 *  Pass a stable array: the assignment reruns whenever it changes. */
export function useSeriesColors(series: readonly SeriesCost[]): SeriesColors {
  const { palette, paletteType } = usePalette();
  const colorblind = paletteType === 'colorblind';
  return useMemo(() => assignSeriesColors(series, palette, { colorblind }), [series, palette, colorblind]);
}
