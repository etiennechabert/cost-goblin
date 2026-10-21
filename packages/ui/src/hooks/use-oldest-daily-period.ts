import { useContext, useEffect, useState } from 'react';
import { asDateString } from '@costgoblin/core/browser';
import type { DateString } from '@costgoblin/core/browser';
import { CostApiContext } from './use-cost-api.js';

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

/** The first day of the oldest `YYYY-MM` daily period held locally by any
 *  configured provider ("All synced data" starts there), or `null` until the
 *  inventories load and when nothing is local. `enabled: false` skips the
 *  inventory calls, which list every provider's remote bucket: only Monthly
 *  mode has an "All synced data" preset to feed. */
export function useOldestDailyPeriod(enabled = true): DateString | null {
  const api = useContext(CostApiContext);
  const [oldest, setOldest] = useState<DateString | null>(null);

  useEffect(() => {
    if (api === null || !enabled) return;
    let cancelled = false;
    api.getConfig().then(async config => {
      const inventories = await Promise.all(
        config.providers.map(provider => api.getDataInventory('daily', provider.name)),
      );
      if (cancelled) return;
      let earliest: string | null = null;
      for (const inventory of inventories) {
        for (const { period, localStatus } of inventory.periods) {
          if (localStatus === 'missing' || !PERIOD_PATTERN.test(period)) continue;
          if (earliest === null || period < earliest) earliest = period;
        }
      }
      setOldest(earliest === null ? null : asDateString(`${earliest}-01`));
    }).catch(() => {
      if (cancelled) return;
      setOldest(null);
    });
    return () => { cancelled = true; };
  }, [api, enabled]);

  return oldest;
}
