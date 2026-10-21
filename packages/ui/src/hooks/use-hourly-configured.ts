import { useContext, useEffect, useState } from 'react';
import { CostApiContext } from './use-cost-api.js';

/** The longest hourly retention across the providers that have an hourly tier
 *  configured, or `null` when none does. Hourly queries union across providers, so a single
 *  provider with hourly data is enough to light up the hourly affordances. */
export function useHourlyRetentionDays(): number | null {
  const api = useContext(CostApiContext);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

  useEffect(() => {
    if (api === null) return;
    let cancelled = false;
    api.getConfig().then(config => {
      if (cancelled) return;
      let longest: number | null = null;
      for (const provider of config.providers) {
        const hourly = provider.sync.hourly;
        if (hourly === undefined || hourly.bucket.length === 0) continue;
        const days = hourly.retentionDays;
        if (longest === null || days > longest) longest = days;
      }
      setRetentionDays(longest);
    }).catch(() => {
      if (cancelled) return;
      setRetentionDays(null);
    });
    return () => { cancelled = true; };
  }, [api]);

  return retentionDays;
}

/** True when ANY configured provider has an hourly tier configured: the
 *  granularity toggle's Hourly button, etc. */
export function useHourlyConfigured(): boolean {
  return useHourlyRetentionDays() !== null;
}
