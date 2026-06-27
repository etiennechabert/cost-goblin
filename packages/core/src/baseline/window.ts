import type { BaselineDailyPoint } from '../types/baseline.js';
import type { DateString } from '../types/branded.js';
import { asDateString, asDollars } from '../types/branded.js';

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

function formatDate(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Expand a sparse daily history into a dense window of `days` points ending at
 *  `endDate` (inclusive), filling missing days with $0. Days outside the window
 *  are dropped. Used to render the fixed 365-day cost-history chart without a
 *  live query. */
export function expandToWindow(
  history: readonly BaselineDailyPoint[],
  days: number,
  endDate: DateString,
): readonly BaselineDailyPoint[] {
  const byDate = new Map<string, number>();
  for (const p of history) byDate.set(p.date, p.cost);
  const end = parseDate(endDate);
  const out: BaselineDailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = formatDate(d);
    out.push({ date: asDateString(key), cost: asDollars(byDate.get(key) ?? 0) });
  }
  return out;
}

/** Trailing (backward-looking) moving average of the cost series over `window`
 *  days, aligned to each point's date. Used for the 30-day trend line overlay. */
export function movingAverage(series: readonly BaselineDailyPoint[], window: number): readonly BaselineDailyPoint[] {
  const w = Math.max(1, window);
  return series.map((p, i) => {
    const start = Math.max(0, i - w + 1);
    const slice = series.slice(start, i + 1);
    let sum = 0;
    for (const s of slice) sum += s.cost;
    return { date: p.date, cost: asDollars(slice.length > 0 ? sum / slice.length : 0) };
  });
}
