// Calendar windows the main-process handlers anchor on "now". Pure, and taking
// `nowMs` explicitly, so they read the injected IpcContext clock (pinned by
// COSTGOBLIN_NOW in e2e) and never Date.
import { asDateString, asHourString, assertHourString, capDateRange, DEFAULT_LAG_DAYS, daysBefore, trailingWindow } from '@costgoblin/core';
import type { DateString } from '@costgoblin/core';

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
  return { startStr: toIsoDate(start), endStr: toIsoDate(end), windowDays: windowDaysOf(start, end) };
}

function windowDaysOf(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** The Explorer's requested range when valid, else the default window ending
 *  `lagDays` before `nowMs`. */
export function resolveExplorerDateRange(
  raw: { start?: string | undefined; end?: string | undefined; startHour?: string | undefined; endHour?: string | undefined } | undefined,
  nowMs: number,
  lagDays: number = DEFAULT_LAG_DAYS,
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
  const fallback = trailingWindow(nowMs, lagDays, DEFAULT_WINDOW_DAYS);
  return { startStr: fallback.start, endStr: fallback.end, windowDays: DEFAULT_WINDOW_DAYS };
}

/** A resolved range with its end capped at the freshness `cutoff` (see core's
 *  capDateRange); null when it lies entirely after it. */
export function capResolvedRange(range: ResolvedDateRange, cutoff: DateString): ResolvedDateRange | null {
  const capped = capDateRange({
    start: asDateString(range.startStr),
    end: asDateString(range.endStr),
    startHour: range.startHour === undefined ? undefined : asHourString(range.startHour),
    endHour: range.endHour === undefined ? undefined : asHourString(range.endHour),
  }, cutoff);
  if (capped === null) return null;
  if (capped.end === range.endStr) return range;
  return {
    startStr: capped.start,
    endStr: capped.end,
    windowDays: windowDaysOf(new Date(`${capped.start}T00:00:00Z`), new Date(`${capped.end}T00:00:00Z`)),
    ...(capped.startHour === undefined ? {} : { startHour: capped.startHour }),
    ...(capped.endHour === undefined ? {} : { endHour: capped.endHour }),
  };
}

export interface PreviewWindow {
  readonly windowDays: number;
  readonly startDate: string;
  readonly endDate: string;
}

/** The Cost Scope preview's window: the period picked on the preview when
 *  valid, else the last 30 days of billing data ending `lagDays` before
 *  `nowMs`. */
export function costScopePreviewWindow(requested: unknown, nowMs: number, lagDays: number): PreviewWindow {
  const picked = parseDayRange(requested);
  if (picked !== null) return { windowDays: picked.windowDays, startDate: picked.startStr, endDate: picked.endStr };
  const { start, end } = trailingWindow(nowMs, lagDays, PREVIEW_WINDOW_DAYS);
  return { windowDays: PREVIEW_WINDOW_DAYS, startDate: start, endDate: end };
}

/** A preview window capped at the freshness `cutoff`; null when it lies
 *  entirely after it. */
export function capPreviewWindow(window: PreviewWindow, cutoff: DateString): PreviewWindow | null {
  const capped = capResolvedRange({ startStr: window.startDate, endStr: window.endDate, windowDays: window.windowDays }, cutoff);
  return capped === null ? null : { windowDays: capped.windowDays, startDate: capped.startStr, endDate: capped.endStr };
}

/** First day (YYYY-MM-DD) of the Dimensions resource-tag discovery sample. */
export function tagDiscoverySince(nowMs: number): string {
  return daysBefore(nowMs, TAG_DISCOVERY_DAYS);
}
