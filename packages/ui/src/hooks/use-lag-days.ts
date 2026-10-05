import { useEffect, useState } from 'react';
import { DEFAULT_LAG_DAYS } from '@costgoblin/core/browser';
import { useCostApi } from './use-cost-api.js';

/** `loaded` is false until the configured lag has been read — and stays false
 *  if the read fails — with the default in force meanwhile. */
export type LagDaysState =
  | { readonly loaded: false; readonly lagDays: typeof DEFAULT_LAG_DAYS }
  | { readonly loaded: true; readonly lagDays: number };

const NOT_LOADED: LagDaysState = { loaded: false, lagDays: DEFAULT_LAG_DAYS };

/** The cost scope's data-freshness lag. It is read asynchronously, so anything
 *  seeded from it at mount must catch up once `loaded` flips — see
 *  useDefaultDateRange. */
export function useLagDays(): LagDaysState {
  const api = useCostApi();
  const [lag, setLag] = useState<LagDaysState>(NOT_LOADED);
  useEffect(() => {
    let cancelled = false;
    api.getCostScope().then(scope => {
      if (cancelled) return;
      setLag({ loaded: true, lagDays: scope.lagDays ?? DEFAULT_LAG_DAYS });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);
  return lag;
}
