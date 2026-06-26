import type { RollupStatus } from '@costgoblin/core/browser';
import { monthsInRange } from './dates.js';

export interface RollupGateState {
  /** True when the rollup can't serve the selected period and a build is in
   *  progress to make it so — the view should show the building overlay instead
   *  of mounting widgets that would grind on the slow raw path. */
  readonly blocked: boolean;
  /** Every YYYY-MM the selected range spans. */
  readonly selectedMonths: readonly string[];
  /** The selected months still waiting to be built (pending or in flight). */
  readonly pendingMonths: readonly string[];
}

/** Decide whether a rollup-backed view should block on a not-yet-built period.
 *
 *  Availability-driven, exception-style: the question is purely "is the rollup
 *  present for the months I'm viewing?", never "was it ever ready this session".
 *  During `computing`, `status.periods` is ordered completed-first — the first
 *  `done` entries are built, the tail (`periods.slice(done)`) is still pending
 *  or in flight, and any month NOT in `periods` at all is a partition left
 *  untouched by this build (still valid, still served). So a viewed month is
 *  unavailable iff it falls in that pending tail.
 *
 *  This blocks both a cold first build AND a cleared/rebuilt rollup (every month
 *  is in the batch, so any viewed month is pending until rebuilt). A re-roll of
 *  months the user isn't viewing leaves their partitions valid → not blocked,
 *  and the non-blocking "Updating…" badge covers that case instead. */
export function rollupGate(
  status: RollupStatus,
  range: { readonly start: string; readonly end: string },
): RollupGateState {
  const selectedMonths = monthsInRange(range);
  if (status.state !== 'computing') {
    return { blocked: false, selectedMonths, pendingMonths: [] };
  }
  const notBuilt = new Set(status.periods.slice(status.done));
  const pendingMonths = selectedMonths.filter((m) => notBuilt.has(m));
  return { blocked: pendingMonths.length > 0, selectedMonths, pendingMonths };
}
