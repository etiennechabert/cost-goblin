import { createContext, useContext } from 'react';
import type { CostApi } from '@costgoblin/core/browser';

const CostApiContext = createContext<CostApi | null>(null);

export function useCostApi(): CostApi {
  const api = useContext(CostApiContext);
  if (api === null) throw new Error('CostApiContext not provided');
  return api;
}

export const CostApiProvider = CostApiContext.Provider;
