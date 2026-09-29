/** Whole minutes until an idle sharing session stops on its own, rounded up
 *  and never below 1 (a deadline that has just passed is a stop in flight,
 *  not "0 min"). Null when there is no deadline or it can't be read. Pure —
 *  the caller passes the clock. */
export function autoStopMinutes(autoStopsAt: string | null, nowMs: number): number | null {
  if (autoStopsAt === null) return null;
  const at = Date.parse(autoStopsAt);
  if (Number.isNaN(at)) return null;
  return Math.max(1, Math.ceil((at - nowMs) / 60_000));
}

/** The "Auto-stops in N min if idle" hint shared by the sharing banner and
 *  the share panel, or null when there is nothing to show. */
export function autoStopLabel(autoStopsAt: string | null, nowMs: number): string | null {
  const minutes = autoStopMinutes(autoStopsAt, nowMs);
  return minutes === null ? null : `Auto-stops in ${String(minutes)} min if idle`;
}
