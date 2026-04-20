const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive count of days between two ISO date strings. */
export function daysBetween(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / DAY_MS) + 1;
}
