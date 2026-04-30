import type { DateString } from '@costgoblin/core/browser';
import { asDateString } from '@costgoblin/core/browser';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive count of days between two ISO date strings. */
export function daysBetween(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / DAY_MS) + 1;
}

export function daysAgo(days: number): DateString {
  const d = new Date(Date.now() - days * DAY_MS);
  return asDateString(d.toISOString().slice(0, 10));
}

/** Format a date as YYYY-MM-DD in UTC. */
function formatDateUTC(date: Date): DateString {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return asDateString(`${year}-${month}-${day}`);
}

/** Returns start and end of current month. */
export function getThisMonth(): { start: DateString; end: DateString } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0)); // Day 0 = last day of previous month

  return {
    start: formatDateUTC(start),
    end: formatDateUTC(end),
  };
}

/** Returns start and end of previous month. */
export function getLastMonth(): { start: DateString; end: DateString } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // Day 0 = last day of previous month

  return {
    start: formatDateUTC(start),
    end: formatDateUTC(end),
  };
}

/** Returns start and end of current quarter (Q1: Jan-Mar, Q2: Apr-Jun, Q3: Jul-Sep, Q4: Oct-Dec). */
export function getCurrentQuarter(): { start: DateString; end: DateString } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3);
  const startMonth = quarter * 3;

  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));

  return {
    start: formatDateUTC(start),
    end: formatDateUTC(end),
  };
}

/** Returns start of year to today (Year To Date). */
export function getYTD(): { start: DateString; end: DateString } {
  const now = new Date();
  const year = now.getUTCFullYear();

  const start = new Date(Date.UTC(year, 0, 1)); // January 1st

  return {
    start: formatDateUTC(start),
    end: formatDateUTC(now),
  };
}
