import type { RollupStatus } from '@costgoblin/core/browser';
import { monthsInRange } from './dates.js';

export interface RollupGateState {
  /** True when the selected range can't yet be served from the rollup and no
   *  prior rollup exists to fall back on — i.e. a cold first build. The view
   *  should show the building overlay instead of mounting widgets. */
  readonly blocked: boolean;
  /** Every YYYY-MM the selected range spans. */
  readonly selectedMonths: readonly string[];
  /** The selected months still waiting to be built (pending or in flight). */
  readonly pendingMonths: readonly string[];
}

/** Decide whether a rollup-backed view should block on a not-yet-built period.
 *
 *  Only a *cold* build blocks: `everReady` is false (the rollup has never been
 *  ready this session), so there's no prior rollup serving these months — the
 *  widgets would grind on the slow raw path with no explanation. An incremental
 *  re-roll (`everReady` true) keeps data on screen and is surfaced by the
 *  non-blocking "Updating…" badge instead, so it never blocks.
 *
 *  During `computing`, `status.periods` is ordered completed-first: the first
 *  `done` entries are built, the tail (`periods.slice(done)`) is still pending
 *  or in flight. A month not in `periods` at all is already valid (a partial
 *  re-roll) — but on a cold build `periods` is the full set, so the tail is the
 *  authoritative "not yet available" list. */
export function rollupGate(
  status: RollupStatus,
  everReady: boolean,
  range: { readonly start: string; readonly end: string },
): RollupGateState {
  const selectedMonths = monthsInRange(range);
  if (status.state !== 'computing' || everReady) {
    return { blocked: false, selectedMonths, pendingMonths: [] };
  }
  const notBuilt = new Set(status.periods.slice(status.done));
  const pendingMonths = selectedMonths.filter((m) => notBuilt.has(m));
  return { blocked: pendingMonths.length > 0, selectedMonths, pendingMonths };
}
