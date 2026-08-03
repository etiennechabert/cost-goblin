import { useContext, useEffect, useState } from 'react';
import { CostApiContext } from './use-cost-api.js';

/** True when ANY configured provider has an hourly tier configured. Hourly
 *  queries union across providers, so a single provider with hourly data is
 *  enough to light up the hourly affordances (granularity toggle, etc.). */
export function useHourlyConfigured(): boolean {
  const api = useContext(CostApiContext);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    if (api === null) return;
    let cancelled = false;
    api.getConfig().then(config => {
      if (cancelled) return;
      setConfigured(config.providers.some(provider => {
        const hourly = provider.sync.hourly;
        return hourly !== undefined && hourly.bucket.length > 0;
      }));
    }).catch(() => {
      if (cancelled) return;
      setConfigured(false);
    });
    return () => { cancelled = true; };
  }, [api]);

  return configured;
}
