import { useEffect, useState } from 'react';
import { DEFAULT_LAG_DAYS } from '@costgoblin/core/browser';
import type { CostApi } from '@costgoblin/core/browser';
import { useCostApi } from './use-cost-api.js';

// The lag each CostApi last answered with. A view mounted after the first
// load starts on it rather than the default, so its first queries already
// use the right window; the fetch below still catches a lag saved since.
const lastKnownLag = new WeakMap<CostApi, number>();

export function useLagDays(): number {
  const api = useCostApi();
  const [lagDays, setLagDays] = useState(() => lastKnownLag.get(api) ?? DEFAULT_LAG_DAYS);
  useEffect(() => {
    api.getCostScope().then(scope => {
      const lag = scope.lagDays ?? DEFAULT_LAG_DAYS;
      lastKnownLag.set(api, lag);
      setLagDays(lag);
    }).catch(() => undefined);
  }, [api]);
  return lagDays;
}
