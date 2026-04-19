import { useEffect, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';

/**
 * Small spinning glyph for the top nav that lights up whenever the
 * background optimizer is chewing through files. Polled at the same
 * cadence as the Sync panel itself so the two stay in step.
 */
export function SyncActivityIndicator(): React.JSX.Element | null {
  const api = useCostApi();
  const [active, setActive] = useState(false);
  const [queued, setQueued] = useState(0);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const [s, e] = await Promise.all([api.getOptimizeStatus(), api.getOptimizeEnabled()]);
        if (!cancelled) {
          setActive(s.running);
          setQueued(s.queued);
          setEnabled(e);
        }
      } catch { /* transient */ }
    }
    void tick();
    const timer = setInterval(() => { void tick(); }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api]);

  // Hide when paused — a non-spinning queue isn't "activity".
  if (!enabled) return null;
  if (!active && queued === 0) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded text-warning text-[11px] tabular-nums"
      title={`Optimizer ${active ? 'running' : 'idle'} · ${String(queued)} queued`}
    >
      <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-6.2-8.55" />
      </svg>
      {queued > 0 && <span>{String(queued)}</span>}
    </span>
  );
}
