import { useContext, useEffect, useState } from 'react';
import { CostApiContext } from './use-cost-api.js';

export function useHourlyConfigured(): boolean {
  const api = useContext(CostApiContext);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    if (api === null) return;
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
