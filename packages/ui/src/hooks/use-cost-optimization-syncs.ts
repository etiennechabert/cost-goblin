import { useEffect, useState } from 'react';
import type { CostApi, SyncStatus } from '@costgoblin/core/browser';

/** The last finish time each provider's cost-optimization sync reported, in
 *  epoch ms, or null before its first one. Keyed by the composite syncId. */
type FinishTimes = ReadonlyMap<string, number | null>;

/** Records what this poll saw and says whether a sync downloaded something
 *  since the previous one. A running sync keeps the time seen before it.
 *  The first poll only records: a sync that finished before the caller's
 *  data was read is already in it. */
export function noteSyncFinishes(
  previous: FinishTimes | null,
  statuses: readonly (readonly [string, SyncStatus])[],
): { readonly seen: FinishTimes; readonly downloaded: boolean } {
  const seen = new Map<string, number | null>();
  let downloaded = false;
  for (const [syncId, status] of statuses) {
    const before = previous?.get(syncId) ?? null;
    if (status.status === 'syncing') {
      seen.set(syncId, before);
      continue;
    }
    const at = status.lastSync?.getTime() ?? null;
    seen.set(syncId, at);
    if (previous !== null && status.status === 'completed' && status.filesDownloaded > 0 && at !== before) {
      downloaded = true;
    }
  }
  return { seen, downloaded };
}

/** A number that goes up each time a provider's cost-optimization sync
 *  finishes having downloaded files, for a view to refetch on. Polls only the
 *  providers with that tier configured; a failed poll is skipped, and a
 *  tick that comes while the previous poll is still out is dropped. */
export function useCostOptimizationSyncs(api: CostApi, intervalMs: number): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let previous: FinishTimes | null = null;
    // One poll at a time: a slow answer must not land after a newer one.
    let polling = false;

    async function poll(syncIds: readonly string[]): Promise<void> {
      if (polling) return;
      polling = true;
      try {
        const statuses = await Promise.all(syncIds.map(async (id): Promise<readonly [string, SyncStatus]> => [id, await api.getSyncStatus(id)]));
        if (cancelled) return;
        const { seen, downloaded } = noteSyncFinishes(previous, statuses);
        previous = seen;
        if (downloaded) setRevision(r => r + 1);
      } finally {
        polling = false;
      }
    }

    api.getConfig().then(config => {
      if (cancelled) return;
      const syncIds = config.providers
        .filter(p => p.sync.costOptimization !== undefined)
        .map(p => `${p.name}:cost-optimization`);
      if (syncIds.length === 0) return;
      poll(syncIds).catch(() => undefined);
      timer = setInterval(() => { poll(syncIds).catch(() => undefined); }, intervalMs);
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [api, intervalMs]);

  return revision;
}
