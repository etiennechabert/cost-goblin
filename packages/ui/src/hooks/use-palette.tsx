import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { getActivePalette } from '../lib/palette.js';
import type { PaletteType } from '../lib/palette.js';

interface PaletteContextValue {
  readonly paletteType: PaletteType;
  readonly palette: readonly string[];
}

const PaletteContext = createContext<PaletteContextValue | undefined>(undefined);

interface PaletteProviderProps {
  readonly children: ReactNode;
  readonly palette?: PaletteType;
}

export function PaletteProvider({ children, palette: paletteType = 'standard' }: PaletteProviderProps): React.JSX.Element {
  const value = useMemo<PaletteContextValue>(
    () => ({
      paletteType,
      palette: getActivePalette(paletteType),
    }),
    [paletteType],
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
