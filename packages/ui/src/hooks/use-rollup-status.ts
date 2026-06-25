import { useEffect, useState } from 'react';
import type { CostApi } from '@costgoblin/core/browser';

/**
 * Poll the background rollup-maintenance state so the dashboard can badge
 * widgets "updating…" while a partition re-rolls after a sync.
 *
 * Returns the YYYY-MM months whose existing partition is currently being
 * re-rolled (empty the rest of the time). Re-rolls are short (a few seconds)
 * and only follow a sync, so we poll a touch faster while one is in flight and
 * back off when idle — enough to catch the window and clear promptly without a
 * constant tight loop. Mounted only on the dashboard, so polling stops on
 * navigation away.
 */
const IDLE_INTERVAL_MS = 2500;
const ACTIVE_INTERVAL_MS = 1500;

export function useRollupStatus(api: CostApi, enabled = true): readonly string[] {
  const [periods, setPeriods] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!enabled) {
      setPeriods([]);
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      let next: readonly string[] = [];
      try {
        const status = await api.getRollupStatus();
        next = status.reRollingPeriods;
      } catch { /* transient — treat as idle */ }
      if (cancelled) return;
      setPeriods(prev => (sameSet(prev, next) ? prev : next));
      timer = setTimeout(() => { tick().catch(() => undefined); }, next.length > 0 ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
    }

    tick().catch(() => undefined);
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [api, enabled]);

  return periods;
}

/** Stable-identity guard so widgets don't re-render on every idle poll. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(p => set.has(p));
}
