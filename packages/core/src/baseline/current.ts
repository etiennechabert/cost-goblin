import type { BaselineCurrent, BaselineDailyPoint } from '../types/baseline.js';
import { asDateString, asDollars } from '../types/branded.js';

const DAY_MS = 86_400_000;

function midnightUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Average daily cost over the most recent `windowDays` *calendar* days of the
 *  series. The stored history is sparse — it omits $0 days — so a positional
 *  slice of the last N points would silently exclude idle days and overstate the
 *  recent daily average. Instead, sum the trailing `windowDays`-day window and
 *  divide by its calendar length (idle days count as $0), clamped to the first
 *  day with data so we never divide by days before the baseline existed. Returns
 *  null for an empty series. The series is sorted by date so callers need not
 *  pre-sort. */
export function computeCurrent(series: readonly BaselineDailyPoint[], windowDays: number): BaselineCurrent | null {
  if (series.length === 0) return null;
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;
  const endMs = midnightUtcMs(last.date);
  const earliestMs = midnightUtcMs(first.date);
  const startMs = Math.max(endMs - (Math.max(1, windowDays) - 1) * DAY_MS, earliestMs);
  let sum = 0;
  for (const p of sorted) {
    const t = midnightUtcMs(p.date);
    if (t >= startMs && t <= endMs) sum += p.cost;
  }
  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  return {
    avgDaily: asDollars(sum / days),
    windowStart: asDateString(new Date(startMs).toISOString().slice(0, 10)),
    windowEnd: last.date,
    days,
  };
}
