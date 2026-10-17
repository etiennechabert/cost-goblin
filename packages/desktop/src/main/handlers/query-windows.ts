// Calendar windows the main-process handlers anchor on "now". Pure, and taking
// `nowMs` explicitly, so they read the injected IpcContext clock (pinned by
// COSTGOBLIN_NOW in e2e) and never Date.
import { assertHourString, DEFAULT_LAG_DAYS, daysBefore, trailingWindow } from '@costgoblin/core';

const DEFAULT_WINDOW_DAYS = 30;
const PREVIEW_WINDOW_DAYS = 30;
const TAG_DISCOVERY_DAYS = 30;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s: string | undefined): Date | null {
  if (s === undefined || !ISO_DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface ResolvedDateRange {
  readonly startStr: string;
  readonly endStr: string;
  readonly windowDays: number;
  readonly startHour?: string;
  readonly endHour?: string;
}

/** A renderer-supplied `{ start, end }` when both are YYYY-MM-DD days in order,
 *  else null. The strings are re-serialized from the parsed dates, so they are
 *  safe to interpolate into SQL. */
function parseDayRange(raw: unknown): ResolvedDateRange | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const start = 'start' in raw && typeof raw.start === 'string' ? parseDate(raw.start) : null;
  const end = 'end' in raw && typeof raw.end === 'string' ? parseDate(raw.end) : null;
  if (start === null || end === null || start.getTime() > end.getTime()) return null;
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return { startStr: toIsoDate(start), endStr: toIsoDate(end), windowDays: days };
}

/** The Explorer's requested range when valid, else the default window ending
 *  at the default lag before `nowMs`. */
export function resolveExplorerDateRange(
  raw: { start?: string | undefined; end?: string | undefined; startHour?: string | undefined; endHour?: string | undefined } | undefined,
  nowMs: number,
): ResolvedDateRange {
  const base = parseDayRange(raw);
  if (base !== null) {
    // Hour bounds are an additive refinement from drag-zoom on the histogram.
    // Validate up front so a malformed value can't reach the SQL builder.
    if (typeof raw?.startHour === 'string' && typeof raw.endHour === 'string') {
      try {
        assertHourString(raw.startHour);
        assertHourString(raw.endHour);
        return { ...base, startHour: raw.startHour, endHour: raw.endHour };
      } catch {
        // fall through to day-only range
      }
    }
    return base;
  }
  const fallback = trailingWindow(nowMs, DEFAULT_LAG_DAYS, DEFAULT_WINDOW_DAYS);
  return { startStr: fallback.start, endStr: fallback.end, windowDays: DEFAULT_WINDOW_DAYS };
}

/** The Cost Scope preview's window: the period picked on the preview when
 *  valid, else the last 30 days of billing data ending `lagDays` before
 *  `nowMs`. */
export function costScopePreviewWindow(requested: unknown, nowMs: number, lagDays: number): { windowDays: number; startDate: string; endDate: string } {
  const picked = parseDayRange(requested);
  if (picked !== null) return { windowDays: picked.windowDays, startDate: picked.startStr, endDate: picked.endStr };
  const { start, end } = trailingWindow(nowMs, lagDays, PREVIEW_WINDOW_DAYS);
  return { windowDays: PREVIEW_WINDOW_DAYS, startDate: start, endDate: end };
}

/** First day (YYYY-MM-DD) of the Dimensions resource-tag discovery sample. */
export function tagDiscoverySince(nowMs: number): string {
  return daysBefore(nowMs, TAG_DISCOVERY_DAYS);
}
