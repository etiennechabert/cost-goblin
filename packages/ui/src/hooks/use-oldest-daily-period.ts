import { useContext, useEffect, useState } from 'react';
import { asDateString } from '@costgoblin/core/browser';
import type { CostApi, DateString } from '@costgoblin/core/browser';
import { CostApiContext } from './use-cost-api.js';

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

async function readOldestLocalPeriod(api: CostApi): Promise<DateString | null> {
  const config = await api.getConfig();
  // One provider that fails to read must not hide the others' data.
  const results = await Promise.allSettled(
    config.providers.map(provider => api.getLocalDataInventory('daily', provider.name)),
  );
  let earliest: string | null = null;
  for (const result of results) {
    if (result.status === 'rejected') continue;
    const period = result.value.local.oldestPeriod;
    if (period === null || !PERIOD_PATTERN.test(period)) continue;
    if (earliest === null || period < earliest) earliest = period;
  }
  return earliest === null ? null : asDateString(`${earliest}-01`);
}

/** The first day of the oldest `YYYY-MM` daily period held locally by any
 *  configured provider ("All synced data" starts there), or `null` until the
 *  inventories load and when nothing is local. Reads the data folders only:
 *  no remote listing, so a month held locally but expired in the bucket still
 *  counts and mounting costs no network call. Each mount reads again, so a
 *  sync or prune since the last visit to Monthly shows. `enabled: false`
 *  skips the reads: only Monthly mode has an "All synced data" preset to feed. */
export function useOldestDailyPeriod(enabled = true): DateString | null {
  const api = useContext(CostApiContext);
  const [oldest, setOldest] = useState<DateString | null>(null);

  useEffect(() => {
    if (api === null || !enabled) return;
    let cancelled = false;
    readOldestLocalPeriod(api).then(period => {
      if (!cancelled) setOldest(period);
    }).catch(() => {
      if (!cancelled) setOldest(null);
    });
    return () => { cancelled = true; };
  }, [api, enabled]);

  return oldest;
}
