import type { Granularity } from '../components/date-range-picker.js';
import { daysBetween } from './dates.js';

const HOURLY_THRESHOLD_DAYS = 7;

export function pixelToIndex(x: number, containerWidth: number, bucketCount: number): number {
  if (bucketCount <= 0 || containerWidth <= 0) return 0;
  const slot = containerWidth / bucketCount;
  const idx = Math.floor(x / slot);
  if (idx < 0) return 0;
  if (idx >= bucketCount) return bucketCount - 1;
  return idx;
}

/** Map a drag overlay onto bar indices by majority coverage: a bar is included
 *  only if more than half of its width is under the overlay. This means the
 *  user can intentionally overshoot on either edge (start the drag inside the
 *  bar before the period and end inside the bar after) and the boundary bars
 *  drop out instead of being captured.
 *
 *  When the drag is so narrow that no bar is majority-covered (typically a
 *  small drag inside a single wide bar), fall back to the bar under the drag
 *  midpoint so single-hour selections still work. */
export function pixelRangeToBars(
  minX: number,
  maxX: number,
  containerWidth: number,
  bucketCount: number,
): { startIdx: number; endIdx: number } | null {
  if (bucketCount <= 0 || containerWidth <= 0) return null;
  const slot = containerWidth / bucketCount;
  const half = slot / 2;
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < bucketCount; i++) {
    const left = i * slot;
    const right = left + slot;
    const overlap = Math.max(0, Math.min(maxX, right) - Math.max(minX, left));
    if (overlap > half) {
      if (startIdx === -1) startIdx = i;
      endIdx = i;
    }
  }
  if (startIdx >= 0) return { startIdx, endIdx };
  const mid = (minX + maxX) / 2;
  const idx = pixelToIndex(mid, containerWidth, bucketCount);
  return { startIdx: idx, endIdx: idx };
}

export function bucketKeyToDate(key: string): string {
  return key.length >= 10 ? key.slice(0, 10) : key;
}

/** Human-readable label for a bar's time bucket. Hourly bucket keys carry an
 *  `HH:MM` suffix (e.g. "2026-05-01 21:00") and we surface that; daily keys
 *  collapse to date-only ("May 1"). Used for the live drag-zoom edge labels
 *  so the user can see the period before releasing the mouse. */
export function formatBucketKey(key: string): string {
  if (key.length === 0) return '';
  const datePart = key.slice(0, 10);
  const [yearStr, monthStr, dayStr] = datePart.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return key;
  const d = new Date(year, month - 1, day);
  const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS"
  if (key.length >= 16 && key[10] === ' ') {
    const hour = key.slice(11, 16);
    return `${dateLabel} ${hour}`;
  }
  return dateLabel;
}

export function shouldAutoSwitchToHourly(
  startDate: string,
  endDate: string,
  currentGranularity: Granularity,
): boolean {
  if (currentGranularity !== 'daily') return false;
  return daysBetween(startDate, endDate) <= HOURLY_THRESHOLD_DAYS;
}

interface BucketLike {
  readonly date: string;
}

// For bucketed bars (one bar can cover multiple days) the bar's date is the
// *start* of its chunk. The actual end of the selected range is the day
// before the next chunk starts; the last bar falls back to the visible end.
export function computeBucketedRange(
  bars: readonly BucketLike[],
  startIdx: number,
  endIdx: number,
  fallbackEnd: string,
): { startDate: string; endDate: string } | null {
  const startBar = bars[startIdx];
  const endBar = bars[endIdx];
  if (startBar === undefined || endBar === undefined) return null;
  const startDate = bucketKeyToDate(startBar.date);
  const nextBar = bars[endIdx + 1];
  let endDate: string;
  if (nextBar === undefined) {
    endDate = fallbackEnd;
  } else {
    const d = new Date(bucketKeyToDate(nextBar.date) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    endDate = d.toISOString().slice(0, 10);
  }
  if (endDate < startDate) endDate = startDate;
  return { startDate, endDate };
}

/** Normalize an hourly bucket key like "2026-04-30 14:00" or "2026-04-30 14:00:00"
 *  to the canonical `YYYY-MM-DD HH:00:00` HourString form used by the query
 *  layer. Missing seconds are zero-padded; anything that isn't an hourly key
 *  falls through (caller should treat that as not-hourly). */
export function normalizeHourKey(key: string): string | null {
  // Match "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS"
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::\d{2})?$/.exec(key);
  if (m === null) return null;
  const date = m[1];
  const hour = m[2];
  return `${String(date)} ${String(hour)}:00:00`;
}

/** Same as `computeBucketedRange` but for hourly bars. Each bar's `date` is an
 *  hour-bucket key (e.g. "2026-04-30 14:00"). With `bucketBars` collapsing
 *  multiple hours per visual bar, the chunk's first bar gives the start hour;
 *  the next bar's hour minus one gives the end hour, and the last bar falls
 *  back to the visible range end. Inclusive on both ends. Returns null when
 *  the bars don't carry hourly keys. */
export function computeBucketedHourRange(
  bars: readonly BucketLike[],
  startIdx: number,
  endIdx: number,
  fallbackEndHour: string,
): { startHour: string; endHour: string } | null {
  const startBar = bars[startIdx];
  const endBar = bars[endIdx];
  if (startBar === undefined || endBar === undefined) return null;
  const startHour = normalizeHourKey(startBar.date);
  if (startHour === null) return null;
  const nextBar = bars[endIdx + 1];
  let endHour: string;
  if (nextBar === undefined) {
    const fallback = normalizeHourKey(fallbackEndHour);
    endHour = fallback ?? startHour;
  } else {
    const nextHour = normalizeHourKey(nextBar.date);
    if (nextHour === null) return null;
    const d = new Date(nextHour.replace(' ', 'T') + 'Z');
    d.setUTCHours(d.getUTCHours() - 1);
    endHour = `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}:00:00`;
  }
  if (endHour < startHour) endHour = startHour;
  return { startHour, endHour };
}
