import type { DateString } from '../types/branded.js';
import { asDateString } from '../types/branded.js';
import type { Granularity } from '../types/query.js';

/**
 * Whole-period date math for the Weekly and Monthly modes. Weeks are ISO
 * weeks (Monday to Sunday), months are calendar months. Everything is UTC,
 * on `Date.UTC` arithmetic only: no local-time getters, so the machine's zone
 * can never move a bucket.
 */

export type PeriodGranularity = 'weekly' | 'monthly';

interface DayRange {
  readonly start: DateString;
  readonly end: DateString;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;

const MONTH_LABELS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function isPeriodGranularity(g: Granularity): g is PeriodGranularity {
  return g === 'weekly' || g === 'monthly';
}

function toUtcMs(day: DateString): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year ?? Number.NaN, (month ?? Number.NaN) - 1, date ?? Number.NaN);
}

function fromUtcMs(ms: number): DateString {
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return asDateString(`${year}-${month}-${dayOfMonth}`);
}

/** Days since Monday, 0 to 6. */
function daysSinceMonday(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % WEEK_DAYS;
}

/** The first day of the period `day` falls in. */
export function periodStart(day: DateString, g: PeriodGranularity): DateString {
  const ms = toUtcMs(day);
  if (g === 'weekly') return fromUtcMs(ms - daysSinceMonday(ms) * DAY_MS);
  const date = new Date(ms);
  return fromUtcMs(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** The last day of the period `day` falls in (Sunday, or the month's last day). */
export function periodEnd(day: DateString, g: PeriodGranularity): DateString {
  const ms = toUtcMs(day);
  if (g === 'weekly') return fromUtcMs(ms + (WEEK_DAYS - 1 - daysSinceMonday(ms)) * DAY_MS);
  const date = new Date(ms);
  // Day 0 of the next month is the last day of this one.
  return fromUtcMs(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

/** The start of the period `n` periods after `day`'s (negative goes back). */
export function shiftPeriodStart(day: DateString, g: PeriodGranularity, n: number): DateString {
  const start = toUtcMs(periodStart(day, g));
  if (g === 'weekly') return fromUtcMs(start + n * WEEK_DAYS * DAY_MS);
  const date = new Date(start);
  return fromUtcMs(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}

/** The range stretched out to whole periods on both ends. */
export function widenToPeriods(range: DayRange, g: PeriodGranularity): DayRange {
  return { start: periodStart(range.start, g), end: periodEnd(range.end, g) };
}

/** The start of every period the range touches, oldest first. */
export function periodStartsInRange(range: DayRange, g: PeriodGranularity): DateString[] {
  const last = periodStart(range.end, g);
  const starts: DateString[] = [];
  let cursor = periodStart(range.start, g);
  while (cursor <= last) {
    starts.push(cursor);
    cursor = shiftPeriodStart(cursor, g, 1);
  }
  return starts;
}

/** How many periods the range touches. */
export function countPeriods(range: DayRange, g: PeriodGranularity): number {
  return periodStartsInRange(range, g).length;
}

/** The last `n` whole periods ending with the one `newestDay` falls in, the
 *  current unfinished period counting as one of the `n`. */
export function lastNPeriodsRange(n: number, g: PeriodGranularity, newestDay: DateString): DayRange {
  return { start: shiftPeriodStart(newestDay, g, -(n - 1)), end: periodEnd(newestDay, g) };
}

/** The same number of whole periods immediately before the range. */
export function previousPeriodRange(range: DayRange, g: PeriodGranularity): DayRange {
  const whole = widenToPeriods(range, g);
  const count = countPeriods(whole, g);
  return {
    start: shiftPeriodStart(whole.start, g, -count),
    end: periodEnd(shiftPeriodStart(whole.start, g, -1), g),
  };
}

/** The range with its end pulled back to `newestDay`, only when it is past it. */
export function capToNewestDay(range: DayRange, newestDay: DateString): DayRange {
  return range.end > newestDay ? { start: range.start, end: newestDay } : range;
}

/** `W42 2026` (ISO week and week-year) or `Oct 2026`. */
export function formatPeriodLabel(day: DateString, g: PeriodGranularity): string {
  const ms = toUtcMs(day);
  if (g === 'monthly') {
    const date = new Date(ms);
    return `${MONTH_LABELS[date.getUTCMonth()] ?? ''} ${String(date.getUTCFullYear())}`;
  }
  // The Thursday of a week decides which ISO year it belongs to.
  const thursday = ms + (3 - daysSinceMonday(ms)) * DAY_MS;
  const weekYear = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(weekYear, 0, 1)) / (WEEK_DAYS * DAY_MS));
  return `W${String(week)} ${String(weekYear)}`;
}
