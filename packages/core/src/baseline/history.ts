import { isDateString } from '../query/identifier-validator.js';
import type { BaselineDailyPoint } from '../types/baseline.js';
import { asDateString, asDollars } from '../types/branded.js';
import { daysBefore } from '../utils/clock.js';
import { isStringRecord } from '../utils/json.js';

/** A real UTC calendar day as YYYY-MM-DD. isDateString checks the shape only
 *  (month 01-12, day 01-31), so the round trip also rejects a day the month
 *  lacks, like 2026-02-31, which Date.parse rolls into March. */
function isCalendarDay(v: string): boolean {
  return isDateString(v) && daysBefore(Date.parse(`${v}T00:00:00Z`), 0) === v;
}

function parsePoints(raw: readonly unknown[], isDay: (v: string) => boolean): BaselineDailyPoint[] {
  const out: BaselineDailyPoint[] = [];
  for (const p of raw) {
    if (!isStringRecord(p)) continue;
    const date = p['date'];
    if (typeof date !== 'string' || !isDay(date)) continue;
    const cost = p['cost'];
    out.push({ date: asDateString(date), cost: asDollars(typeof cost === 'number' && Number.isFinite(cost) ? cost : 0) });
  }
  return out;
}

/** The `history` section of baselines-data.json (baseline id → daily points),
 *  as the desktop store and the MCP tools both read it. A point is skipped
 *  unless it's an object whose date is a calendar day: computeCurrent would
 *  throw on any other date, failing the derivation of every baseline listed
 *  with it. History is derived, so the next recompute rebuilds what's lost. */
export function parseBaselineHistory(raw: unknown): Map<string, readonly BaselineDailyPoint[]> {
  const history = new Map<string, readonly BaselineDailyPoint[]>();
  if (!isStringRecord(raw)) return history;
  // Baselines share their dates, so check each distinct string once, not once
  // per point: thousands of baselines × 365 points would otherwise take seconds.
  const verdicts = new Map<string, boolean>();
  const isDay = (v: string): boolean => {
    let ok = verdicts.get(v);
    if (ok === undefined) {
      ok = isCalendarDay(v);
      verdicts.set(v, ok);
    }
    return ok;
  };
  for (const [id, pts] of Object.entries(raw)) {
    if (Array.isArray(pts)) history.set(id, parsePoints(pts, isDay));
  }
  return history;
}
