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

/** Chronological order for daily points. Codepoint comparison is deliberate:
 *  ISO `YYYY-MM-DD` dates sort chronologically byte-wise, and this ordering
 *  feeds baseline math in core and the history clamp in desktop — every
 *  consumer must agree on it, so there is exactly one copy. */
export function compareByDate(a: BaselineDailyPoint, b: BaselineDailyPoint): number {
  if (a.date < b.date) return -1;
  return a.date > b.date ? 1 : 0;
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

/** Trailing `windowDays`-day average daily cost at each calendar day of the
 *  observed span, counting missing days as $0 — i.e. the amortized daily
 *  run-rate. A lumpy charge (a monthly fee billed on one day) is spread across
 *  the window, so the series stays flat for periodic/spiky scopes and only moves
 *  on *sustained* changes. This is the basis for the savings band, so a one-off
 *  or periodic spike can't set a phantom ceiling that inflates realized savings.
 *  The first `windowDays-1` warm-up days (whose window isn't yet full) are
 *  dropped; a span shorter than the window returns a single point amortized over
 *  the observed span (so a young periodic scope still amortizes its spike). */
export function runRateSeries(history: readonly BaselineDailyPoint[], windowDays: number): readonly BaselineDailyPoint[] {
  if (history.length === 0) return [];
  const sorted = [...history].sort(compareByDate);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return [];
  const byDate = new Map<string, number>();
  for (const p of sorted) byDate.set(p.date, p.cost);
  const w = Math.max(1, windowDays);
  const startMs = parseDate(first.date).getTime();
  const endMs = parseDate(last.date).getTime();
  const dayMs = 86_400_000;
  const dense: number[] = [];
  for (let t = startMs; t <= endMs; t += dayMs) dense.push(byDate.get(formatDate(new Date(t))) ?? 0);
  // Span shorter than the window — no fully-warmed run-rate point exists. Return a
  // single point: the cost amortized over the observed span (matching computeCurrent's
  // clamped average), so a periodic spike stays amortized instead of banding the raw
  // sparse series and resurrecting the phantom ceiling.
  if (dense.length < w) {
    let s = 0;
    for (const c of dense) s += c;
    return [{ date: last.date, cost: asDollars(s / dense.length) }];
  }
  const out: BaselineDailyPoint[] = [];
  let sum = 0;
  for (let i = 0; i < dense.length; i++) {
    sum += dense[i] ?? 0;
    if (i >= w) sum -= dense[i - w] ?? 0;
    if (i >= w - 1) out.push({ date: asDateString(formatDate(new Date(startMs + i * dayMs))), cost: asDollars(sum / w) });
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
