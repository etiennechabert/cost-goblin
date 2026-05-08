import { useEffect, useState } from 'react';
import { useCostApi } from './use-cost-api.js';

export function useHourlyConfigured(): boolean {
  const api = useCostApi();
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getConfig().then(config => {
      if (cancelled) return;
      const provider = config.providers[0];
      const hourly = provider?.sync.hourly;
      setConfigured(hourly !== undefined && hourly.bucket.length > 0);
    }).catch(() => {
      if (cancelled) return;
      setConfigured(false);
    });
    return () => { cancelled = true; };
  }, [api]);

  return configured;
}
