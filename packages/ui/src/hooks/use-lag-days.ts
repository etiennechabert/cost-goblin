import { useEffect, useState } from 'react';
import { DEFAULT_LAG_DAYS } from '@costgoblin/core/browser';
import { useCostApi } from './use-cost-api.js';

export function useLagDays(): number {
  const api = useCostApi();
  const [lagDays, setLagDays] = useState(DEFAULT_LAG_DAYS);
  useEffect(() => {
    void api.getCostScope().then(scope => {
      setLagDays(scope.lagDays ?? DEFAULT_LAG_DAYS);
    });
  }, [api]);
  return lagDays;
}
