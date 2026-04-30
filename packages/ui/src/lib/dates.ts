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

/** Returns start and end of previous quarter (Q1: Jan-Mar, Q2: Apr-Jun, Q3: Jul-Sep, Q4: Oct-Dec). */
export function getLastQuarter(): { start: DateString; end: DateString } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11

  // Determine current quarter (0-3)
  const currentQuarter = Math.floor(month / 3);

  // Previous quarter
  const prevQuarter = currentQuarter === 0 ? 3 : currentQuarter - 1;
  const prevQuarterYear = currentQuarter === 0 ? year - 1 : year;

  // Start month of previous quarter
  const startMonth = prevQuarter * 3;
  const start = new Date(Date.UTC(prevQuarterYear, startMonth, 1));

  // End is last day of third month in quarter
  const end = new Date(Date.UTC(prevQuarterYear, startMonth + 3, 0));

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
