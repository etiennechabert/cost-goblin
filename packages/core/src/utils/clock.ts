// Leaf module with no imports, published alone as `@costgoblin/core/clock`:
// the sandboxed preload bundles parseFixedNow, and it must not pull in node:
// built-ins or core's logger (the browser barrel would drag both in).

/** Epoch milliseconds for "now" as the app's calendar sees it. Every window
 *  anchored on today (default query ranges, retention cutoffs, baseline
 *  snapshot days) reads it, so e2e can pin it to the fixture data through
 *  COSTGOBLIN_NOW. Elapsed-time uses (durations, timeouts, scheduling, audit
 *  timestamps) keep reading Date directly. */
export type Clock = () => number;

const DAY_MS = 86_400_000;

/** COSTGOBLIN_NOW parsed to epoch ms. Null when unset, empty or unparseable,
 *  which is every real launch. The preload uses it to pin the renderer's Date
 *  and the main process to build its {@link Clock}, so the two always agree. */
export function parseFixedNow(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** A clock frozen at `fixedMs` (a parsed COSTGOBLIN_NOW, matching the
 *  renderer's patched Date), or the real clock when null. */
export function clockPinnedTo(fixedMs: number | null): Clock {
  if (fixedMs === null) return () => Date.now();
  return () => fixedMs;
}

/** The UTC calendar day (YYYY-MM-DD) `days` days before `nowMs`. */
export function daysBefore(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
}

/** The `windowDays`-day inclusive range of UTC days ending `lagDays` before
 *  `nowMs` (the billing data lags real time). */
export function trailingWindow(nowMs: number, lagDays: number, windowDays: number): { start: string; end: string } {
  return { start: daysBefore(nowMs, lagDays + windowDays - 1), end: daysBefore(nowMs, lagDays) };
}
