import { useState } from 'react';
import { CalendarIcon, ChevronDown } from 'lucide-react';
import type { DateRange as DayPickerRange } from 'react-day-picker';
import type { DateString, Granularity, HourString, PeriodGranularity } from '@costgoblin/core/browser';
import {
  DEFAULT_LAG_DAYS,
  asDateString,
  capToNewestDay,
  formatPeriodLabel,
  isPeriodGranularity,
  lastNPeriodsRange,
  periodEnd,
  periodStart,
  widenToPeriods,
} from '@costgoblin/core/browser';
import { daysAgo, getThisMonth, getLastMonth, getCurrentQuarter, getLastQuarter, getYTD, getLastYear, shiftDay } from '../lib/dates.js';
import { shouldAutoSwitchToHourly } from '../lib/drag-select.js';
import { useHourlyRetentionDays } from '../hooks/use-hourly-configured.js';
import { useOldestDailyPeriod } from '../hooks/use-oldest-daily-period.js';
import { MonthRangeGrid } from './month-range-grid.js';
import { Calendar } from './ui/calendar.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export type { Granularity } from '@costgoblin/core/browser';

type DayPreset = {
  readonly label: string;
  readonly type: 'days';
  readonly days: number;
  readonly granularity: Granularity;
  readonly hint?: string;
};

type CalendarPreset = {
  readonly label: string;
  readonly type: 'calendar';
  readonly getRange: () => { start: DateString; end: DateString };
  readonly granularity: Granularity;
  readonly hint?: string;
};

/** A whole-period window (Weekly and Monthly modes): never capped at the newest
 *  day, since the current unfinished period is part of the selection. */
type PeriodPreset = {
  readonly label: string;
  readonly type: 'periods';
  readonly getRange: (newestDay: DateString) => { start: DateString; end: DateString };
  readonly granularity: PeriodGranularity;
  readonly hint?: string;
};

type Preset = DayPreset | CalendarPreset | PeriodPreset;

interface PresetSection {
  readonly section: string;
  readonly items: readonly Preset[];
}

const DAY_PRESETS: readonly PresetSection[] = [
  {
    section: 'Days',
    items: [
      { label: 'Last 7 days', type: 'days', days: 7, granularity: 'hourly', hint: 'hourly' },
      { label: 'Last 14 days', type: 'days', days: 14, granularity: 'daily' },
      { label: 'Last 30 days', type: 'days', days: 30, granularity: 'daily' },
      { label: 'Last 90 days', type: 'days', days: 90, granularity: 'daily' },
      { label: 'Last 180 days', type: 'days', days: 180, granularity: 'daily' },
      { label: 'Last 365 days', type: 'days', days: 365, granularity: 'daily' },
    ],
  },
  {
    section: 'Period',
    items: [
      { label: 'This month', type: 'calendar', getRange: () => getThisMonth(), granularity: 'daily' },
      { label: 'Last month', type: 'calendar', getRange: () => getLastMonth(), granularity: 'daily' },
      { label: 'This quarter', type: 'calendar', getRange: () => getCurrentQuarter(), granularity: 'daily' },
      { label: 'Last quarter', type: 'calendar', getRange: () => getLastQuarter(), granularity: 'daily' },
      { label: 'This year', type: 'calendar', getRange: () => getYTD(), granularity: 'daily' },
      { label: 'Last year', type: 'calendar', getRange: () => getLastYear(), granularity: 'daily' },
    ],
  },
];

function lastNMonths(n: number): PeriodPreset {
  return { label: `Last ${String(n)} months`, type: 'periods', granularity: 'monthly', getRange: newestDay => lastNPeriodsRange(n, 'monthly', newestDay) };
}

function lastNWeeks(n: number): PeriodPreset {
  return { label: `Last ${String(n)} weeks`, type: 'periods', granularity: 'weekly', getRange: newestDay => lastNPeriodsRange(n, 'weekly', newestDay) };
}

const MONTH_PRESETS: readonly PresetSection[] = [
  { section: 'Months', items: [lastNMonths(3), lastNMonths(6), lastNMonths(12), lastNMonths(24)] },
  {
    section: 'Period',
    items: [
      { label: 'This year', type: 'periods', granularity: 'monthly', getRange: () => getYTD() },
      { label: 'Last year', type: 'periods', granularity: 'monthly', getRange: () => getLastYear() },
    ],
  },
];

const WEEK_PRESETS: readonly PresetSection[] = [
  { section: 'Weeks', items: [lastNWeeks(4), lastNWeeks(6), lastNWeeks(12), lastNWeeks(26), lastNWeeks(52)] },
];

/** The presets a mode offers. Monthly's "All synced data" reaches back to the
 *  oldest local daily period, so it only exists once that is known. */
function presetSections(granularity: Granularity, oldestDaily: DateString | null): readonly PresetSection[] {
  if (granularity === 'weekly') return WEEK_PRESETS;
  if (granularity !== 'monthly') return DAY_PRESETS;
  if (oldestDaily === null) return MONTH_PRESETS;
  const allSynced: PeriodPreset = {
    label: 'All synced data',
    type: 'periods',
    granularity: 'monthly',
    getRange: newestDay => ({ start: oldestDaily, end: periodEnd(newestDay, 'monthly') }),
  };
  return MONTH_PRESETS.map(({ section, items }) => section === 'Period' ? { section, items: [...items, allSynced] } : { section, items });
}

const TOGGLE_MODES: readonly { readonly value: Granularity; readonly label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'daily', label: 'Daily' },
  { value: 'hourly', label: 'Hourly' },
];

/** Parse a YYYY-MM-DD string to a local-midnight Date — matches the Date objects react-day-picker hands back. */
function parseDay(s: DateString): Date {
  return new Date(`${s}T00:00:00`);
}

/** Format a Date as YYYY-MM-DD from its local calendar fields (avoids the UTC shift of toISOString). */
function formatDay(d: Date): DateString {
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return asDateString(`${year}-${month}-${day}`);
}

function formatHourBound(hour: HourString): string {
  // "2026-04-30 14:00:00" → "Apr 30 14:00"
  const s = String(hour);
  const date = new Date(`${s.slice(0, 10)}T${s.slice(11, 16)}:00`);
  if (Number.isNaN(date.getTime())) return s;
  const month = date.toLocaleString('en-US', { month: 'short' });
  return `${month} ${String(date.getDate())} ${s.slice(11, 16)}`;
}

export interface DateRange {
  start: DateString;
  end: DateString;
  startHour?: HourString | undefined;
  endHour?: HourString | undefined;
}

interface DateRangePickerProps {
  readonly value: DateRange;
  readonly granularity: Granularity;
  /** `lastNDays` is set when a "Last N days" preset was picked, so a consumer
   *  can keep that window relative (e.g. to a lag it lets the user edit). */
  readonly onChange: (range: DateRange, granularity: Granularity, lastNDays?: number) => void;
  /** For views that only read the daily tier: hides the Daily/Hourly toggle,
   *  and the presets that default to hourly (Last 7 days) pick daily. */
  readonly hideHourly?: boolean;
  readonly lagDays?: number;
  readonly compareEnabled?: boolean;
  readonly onCompareChange?: ((enabled: boolean) => void) | undefined;
}

/** The "Last N days" presets' window: through the newest day `lagDays` allows. */
export function lastNDaysRange(days: number, lagDays: number): DateRange {
  return { start: daysAgo(days + lagDays), end: daysAgo(lagDays) };
}

/** The first day hourly data can reach back to. The sync prunes whole months
 *  (it keeps every month from the one `retentionDays` ago), so it is the first
 *  day of that UTC month, not `retentionDays` days back. */
function hourlyRetentionStart(retentionDays: number): DateString {
  return asDateString(`${daysAgo(retentionDays).slice(0, 7)}-01`);
}

/** The range a mode switch lands on: widen, never cut. Daily and hourly ranges
 *  grow to the whole weeks or months covering them; a weekly or monthly range
 *  keeps its days for Daily, ending no later than the newest day with data;
 *  Hourly keeps the range when it starts inside the hourly retention and falls
 *  back to the last 7 days when it does not. */
export function switchGranularity(
  range: DateRange,
  from: Granularity,
  to: Granularity,
  ctx: { readonly newestDay: DateString; readonly hourlyRetentionDays: number | null },
): DateRange {
  if (from === to) return range;
  if (isPeriodGranularity(to)) return widenToPeriods(range, to);
  const days = { start: range.start, end: range.end };
  if (to === 'daily') return isPeriodGranularity(from) ? capToNewestDay(days, ctx.newestDay) : days;
  const fitted = isPeriodGranularity(from) ? capToNewestDay(days, ctx.newestDay) : range;
  const fits = ctx.hourlyRetentionDays !== null
    && fitted.start <= ctx.newestDay
    && fitted.start >= hourlyRetentionStart(ctx.hourlyRetentionDays);
  return fits ? fitted : { start: shiftDay(ctx.newestDay, -7), end: ctx.newestDay };
}

export function getDefaultDateRange(lagDays: number = DEFAULT_LAG_DAYS): DateRange {
  return lastNDaysRange(30, lagDays);
}

export function DateRangePicker({ value, granularity, onChange, hideHourly, lagDays = DEFAULT_LAG_DAYS, compareEnabled, onCompareChange }: DateRangePickerProps) {
  const hourlyRetentionDays = useHourlyRetentionDays();
  const hourlyAvailable = hideHourly !== true && hourlyRetentionDays !== null;
  const oldestDaily = useOldestDailyPeriod(granularity === 'monthly');
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  // While the user is mid-selection (start picked, end not yet), the committed
  // value still holds the old range — keep the in-progress range here so the
  // calendar highlights it. Cleared once a full range commits or the popover closes.
  const [draftRange, setDraftRange] = useState<DayPickerRange | undefined>(undefined);
  const latestDate = daysAgo(lagDays);
  const sections = presetSections(granularity, oldestDaily);
  const presets = sections.flatMap(section => section.items);

  // Calendar periods stop at the newest day the lag allows, like the queries
  // they run. One that starts after it (This month, early in the month) has
  // nothing to show yet: its start comes after its end.
  function getPresetRange(preset: Preset): DateRange {
    if (preset.type === 'days') return lastNDaysRange(preset.days, lagDays);
    if (preset.type === 'periods') return preset.getRange(latestDate);
    const range = preset.getRange();
    return range.end > latestDate ? { start: range.start, end: latestDate } : range;
  }

  function isPresetAvailable(preset: Preset): boolean {
    const range = getPresetRange(preset);
    return range.start <= latestDate && range.start <= range.end;
  }

  function resolveGranularity(range: DateRange, preferred: Granularity): Granularity {
    // Whole-period modes never drop to hourly on their own.
    if (isPeriodGranularity(preferred)) return preferred;
    if (preferred === 'hourly' && !hourlyAvailable) return 'daily';
    if (preferred === 'daily' && hourlyAvailable && shouldAutoSwitchToHourly(range.start, range.end, 'daily')) return 'hourly';
    return preferred;
  }

  const hasHourBounds = value.startHour !== undefined && value.endHour !== undefined;

  function getActiveLabel(): string {
    if (hasHourBounds && value.startHour !== undefined && value.endHour !== undefined) {
      const base = `${formatHourBound(value.startHour)} → ${formatHourBound(value.endHour)}`;
      return compareEnabled === true ? `${base} vs prev` : base;
    }
    let label: string | undefined;
    for (const preset of presets) {
      const range = getPresetRange(preset);
      if (value.start === range.start && value.end === range.end && granularity === resolveGranularity(range, preset.granularity)) {
        label = preset.label;
        break;
      }
    }
    const base = label ?? (isPeriodGranularity(granularity)
      ? `${formatPeriodLabel(value.start, granularity)} – ${formatPeriodLabel(value.end, granularity)}`
      : `${value.start} → ${value.end}`);
    return compareEnabled === true ? `${base} vs prev` : base;
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Drop any half-finished selection so reopening reflects the committed value.
    if (!next) setDraftRange(undefined);
  }

  function handlePreset(preset: Preset) {
    const range = getPresetRange(preset);
    // Picking a preset is an explicit "back to whole-day mode" gesture —
    // don't carry a previous drag's hour bounds onto the new window.
    onChange(range, resolveGranularity(range, preset.granularity), preset.type === 'days' ? preset.days : undefined);
    setDraftRange(undefined);
    setShowCustom(false);
    setOpen(false);
  }

  function handleCustomRange(range: DateRange) {
    // Same intent as a preset: editing the calendar picks whole days, so any
    // active hour bounds no longer apply. Weekly and Monthly stretch the days
    // to whole periods.
    const picked = isPeriodGranularity(granularity) ? widenToPeriods(range, granularity) : range;
    onChange(picked, resolveGranularity(picked, granularity));
  }

  function handleRangeSelect(range: DayPickerRange | undefined) {
    setDraftRange(range);
    // Only commit once both ends are chosen — a lone start shouldn't refire the query.
    if (range?.from && range.to) {
      handleCustomRange({ start: formatDay(range.from), end: formatDay(range.to) });
      // A weekly pick is committed widened to whole weeks: drop the raw days so
      // the calendar shows the committed value rather than the two clicked days.
      if (granularity === 'weekly') setDraftRange(undefined);
    }
  }

  // While the second click of a weekly range is pending, the whole week of each
  // picked day is tinted, so the user sees the range will snap to full weeks.
  const draftWeeks = granularity === 'weekly' && draftRange?.from !== undefined
    ? {
        from: parseDay(periodStart(formatDay(draftRange.from), 'weekly')),
        to: parseDay(periodEnd(formatDay(draftRange.to ?? draftRange.from), 'weekly')),
      }
    : undefined;

  function handleGranularityToggle(next: Granularity) {
    if (next === granularity) return;
    if (next === 'hourly' && !hourlyAvailable) return;
    onChange(switchGranularity(value, granularity, next, { newestDay: latestDate, hourlyRetentionDays }), next);
  }

  function isActivePreset(preset: Preset): boolean {
    if (hasHourBounds) return false;
    const range = getPresetRange(preset);
    return value.start === range.start && value.end === range.end && granularity === resolveGranularity(range, preset.granularity);
  }

  return (
    <div className="flex items-center gap-2">
      {hideHourly !== true && (
        <div className="inline-flex items-center rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
          {TOGGLE_MODES.map(({ value: mode, label }) => {
            const unavailable = mode === 'hourly' && !hourlyAvailable;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => { handleGranularityToggle(mode); }}
                disabled={unavailable}
                title={unavailable ? 'Hourly tier is not configured' : undefined}
                className={[
                  'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                  granularity === mode
                    ? 'bg-accent text-bg-primary shadow-sm'
                    : 'text-text-muted hover:text-text-primary',
                  unavailable ? 'opacity-50 cursor-not-allowed' : '',
                ].join(' ')}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/30 px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary/50 transition-colors"
        >
          <CalendarIcon className="h-3.5 w-3.5 text-text-muted" />
          <span>{getActiveLabel()}</span>
          <ChevronDown className="h-3 w-3 text-text-muted" />
        </button>
      </PopoverTrigger>
      {/* The weekly calendar adds a week-number column: eight 36px columns plus
          the calendar's padding need more than w-72 leaves. */}
      <PopoverContent className={showCustom && granularity === 'weekly' ? 'w-80 p-0' : 'w-72 p-0'} align="end">
        <div className="flex flex-col">
          {sections.map(({ section, items }) => (
            <div key={section}>
              <div className="px-3 pt-2.5 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{section}</span>
              </div>
              {items.map(preset => {
                const showHint = preset.hint !== undefined && hourlyAvailable;
                const available = isPresetAvailable(preset);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => { handlePreset(preset); }}
                    disabled={!available}
                    title={available ? undefined : `No data yet: the Data freshness lag leaves out the days after ${latestDate}`}
                    className={[
                      'w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors',
                      isActivePreset(preset)
                        ? 'bg-accent/10 text-accent font-medium border-l-2 border-accent'
                        : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary border-l-2 border-transparent',
                      available ? '' : 'opacity-50 cursor-not-allowed',
                    ].join(' ')}
                  >
                    <span>{preset.label}</span>
                    {showHint && (
                      <span className="text-[10px] uppercase tracking-wider text-text-muted">{preset.hint}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {/* Custom date range */}
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => { setShowCustom(prev => !prev); }}
              className={[
                'w-full text-left px-3 py-2 text-xs transition-colors',
                showCustom
                  ? 'text-accent font-medium'
                  : 'text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              Custom range…
            </button>
            {showCustom && (
              <div className="pb-2">
                <div className="flex items-center justify-between px-3 pb-1.5 text-[10px]">
                  <div className="flex items-center gap-1">
                    <span className="text-text-muted">From</span>
                    <span className="font-medium text-text-secondary">{value.start}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-text-muted">To</span>
                    <span className="font-medium text-text-secondary">{value.end}</span>
                  </div>
                </div>
                {granularity === 'monthly' ? (
                  <MonthRangeGrid
                    value={value}
                    newestDay={latestDate}
                    onSelect={range => { handleCustomRange(range); }}
                  />
                ) : (
                  <Calendar
                    mode="range"
                    required={false}
                    resetOnSelect
                    selected={draftRange ?? { from: parseDay(value.start), to: parseDay(value.end) }}
                    onSelect={handleRangeSelect}
                    defaultMonth={parseDay(value.end)}
                    disabled={(date) => formatDay(date) > latestDate}
                    {...(granularity === 'weekly' ? {
                      ISOWeek: true,
                      showWeekNumber: true,
                      // The month arrows are absolutely positioned with no
                      // positioned ancestor but the popover: anchor them to the
                      // calendar, on the caption row, so they stay clear of the
                      // week-number and Sunday columns.
                      className: 'relative [&_nav_button]:top-3 [&_nav_button:first-child]:left-3 [&_nav_button:last-child]:right-3',
                      modifiers: { weekHighlight: draftWeeks ?? [] },
                      modifiersClassNames: { weekHighlight: '[&:not([aria-selected])]:bg-accent/20 rounded-md' },
                    } : {})}
                    autoFocus
                  />
                )}
              </div>
            )}
          </div>

          {onCompareChange !== undefined && (
            <div className="border-t border-border px-3 py-2.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={compareEnabled === true}
                  onChange={(e) => { onCompareChange(e.target.checked); }}
                  className="accent-accent h-3.5 w-3.5 rounded"
                />
                <span className="text-xs text-text-secondary">Compare to previous period</span>
              </label>
            </div>
          )}
        </div>
      </PopoverContent>
      </Popover>
    </div>
  );
}
