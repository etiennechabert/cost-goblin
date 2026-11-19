import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Fakes `Date` at `iso` before each test of the file or `describe` this is
 * called in, and gives the real clock back after each.
 *
 * A view captures its default window once, at mount (`useViewDateRange`),
 * while the date picker names a window "Last 30 days" only while it equals
 * that preset recomputed from the clock at each render. On the real clock a
 * render after a UTC midnight shows the dates instead, and a range a test
 * builds with `daysAgo` is a day off the one the view queried.
 *
 * Only Date is faked, so real timers still drive debounces, `waitFor` and
 * `userEvent`. A nested `describe` that needs another day sets it with its
 * own `beforeEach(() => { vi.setSystemTime(…); })`, which runs after this one.
 */
export function pinDate(iso: string): void {
  const now = new Date(iso);
  if (Number.isNaN(now.getTime())) throw new Error(`pinDate: not a date: ${iso}`);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });
  afterEach(() => { vi.useRealTimers(); });
}
