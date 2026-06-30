import { useState } from 'react';
import { CalendarIcon, ChevronDown } from 'lucide-react';
import type { DateRange as DayPickerRange } from 'react-day-picker';
import type { DateString, HourString } from '@costgoblin/core/browser';
import { DEFAULT_LAG_DAYS, asDateString } from '@costgoblin/core/browser';
import { daysAgo, getThisMonth, getLastMonth, getCurrentQuarter, getLastQuarter, getYTD, getLastYear } from '../lib/dates.js';
import { shouldAutoSwitchToHourly } from '../lib/drag-select.js';
import { useHourlyConfigured } from '../hooks/use-hourly-configured.js';
import { Calendar } from './ui/calendar.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export type Granularity = 'daily' | 'hourly';

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

type Preset = DayPreset | CalendarPreset;

const PRESETS: readonly { section: string; items: readonly Preset[] }[] = [
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

const ALL_PRESETS = PRESETS.flatMap(s => s.items);

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
  readonly onChange: (range: DateRange, granularity: Granularity) => void;
  readonly hideHourly?: boolean;
  readonly lagDays?: number;
  readonly compareEnabled?: boolean;
  readonly onCompareChange?: ((enabled: boolean) => void) | undefined;
}

export function getDefaultDateRange(lagDays: number = DEFAULT_LAG_DAYS): DateRange {
  return { start: daysAgo(30 + lagDays), end: daysAgo(lagDays) };
}

export function DateRangePicker({ value, granularity, onChange, hideHourly, lagDays = DEFAULT_LAG_DAYS, compareEnabled, onCompareChange }: DateRangePickerProps) {
  const hourlyConfigured = useHourlyConfigured();
  const hourlyAvailable = hideHourly !== true && hourlyConfigured;
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  // While the user is mid-selection (start picked, end not yet), the committed
  // value still holds the old range — keep the in-progress range here so the
  // calendar highlights it. Cleared once a full range commits or the popover closes.
  const [draftRange, setDraftRange] = useState<DayPickerRange | undefined>(undefined);
  const latestDate = daysAgo(lagDays);

  function getPresetRange(preset: Preset): DateRange {
    if (preset.type === 'days') {
      return { start: daysAgo(preset.days + lagDays), end: latestDate };
    }
    return preset.getRange();
  }

  function resolveGranularity(range: DateRange, preferred: Granularity): Granularity {
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
    for (const preset of ALL_PRESETS) {
      const range = getPresetRange(preset);
      if (value.start === range.start && value.end === range.end && granularity === resolveGranularity(range, preset.granularity)) {
        label = preset.label;
        break;
      }
    }
    const base = label ?? `${value.start} → ${value.end}`;
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
    onChange(range, resolveGranularity(range, preset.granularity));
    setDraftRange(undefined);
    setShowCustom(false);
    setOpen(false);
  }

  function handleCustomRange(range: DateRange) {
    // Same intent as a preset: editing the calendar picks whole days, so any
    // active hour bounds no longer apply.
    onChange(range, resolveGranularity(range, granularity));
  }

  function handleRangeSelect(range: DayPickerRange | undefined) {
    setDraftRange(range);
    // Only commit once both ends are chosen — a lone start shouldn't refire the query.
    if (range?.from && range.to) {
      handleCustomRange({ start: formatDay(range.from), end: formatDay(range.to) });
    }
  }

  function handleGranularityToggle(next: Granularity) {
    if (next === granularity) return;
    if (next === 'hourly' && !hourlyAvailable) return;
    // Switching to Daily clears hour bounds; switching to Hourly leaves the
    // current day-level range alone (the user can drag-zoom from there).
    const cleared: DateRange = next === 'daily'
      ? { start: value.start, end: value.end }
      : value;
    onChange(cleared, next);
  }

  function isActivePreset(preset: Preset): boolean {
    if (hasHourBounds) return false;
    const range = getPresetRange(preset);
    return value.start === range.start && value.end === range.end && granularity === resolveGranularity(range, preset.granularity);
  }

  const sections = hideHourly === true
    ? PRESETS.map(s => ({
        section: s.section,
        items: s.items.filter(p => p.granularity !== 'hourly'),
      })).filter(s => s.items.length > 0)
    : PRESETS;

  return (
    <div className="flex items-center gap-2">
      {hideHourly !== true && (
        <div className="inline-flex items-center rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
          <button
            type="button"
            onClick={() => { handleGranularityToggle('daily'); }}
            className={[
              'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
              granularity === 'daily'
                ? 'bg-accent text-bg-primary shadow-sm'
                : 'text-text-muted hover:text-text-primary',
            ].join(' ')}
          >
            Daily
          </button>
          <button
            type="button"
            onClick={() => { handleGranularityToggle('hourly'); }}
            disabled={!hourlyAvailable}
            title={hourlyAvailable ? undefined : 'Hourly tier is not configured'}
            className={[
              'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
              granularity === 'hourly'
                ? 'bg-accent text-bg-primary shadow-sm'
                : 'text-text-muted hover:text-text-primary',
              hourlyAvailable ? '' : 'opacity-50 cursor-not-allowed',
            ].join(' ')}
          >
            Hourly
          </button>
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
      <PopoverContent className="w-72 p-0" align="end">
        <div className="flex flex-col">
          {sections.map(({ section, items }) => (
            <div key={section}>
              <div className="px-3 pt-2.5 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{section}</span>
              </div>
              {items.map(preset => {
                const showHint = preset.hint !== undefined && hourlyAvailable;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => { handlePreset(preset); }}
                    className={[
                      'w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors',
                      isActivePreset(preset)
                        ? 'bg-accent/10 text-accent font-medium border-l-2 border-accent'
                        : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary border-l-2 border-transparent',
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
                <Calendar
                  mode="range"
                  required={false}
                  resetOnSelect
                  selected={draftRange ?? { from: parseDay(value.start), to: parseDay(value.end) }}
                  onSelect={handleRangeSelect}
                  defaultMonth={parseDay(value.end)}
                  disabled={(date) => formatDay(date) > latestDate}
                  autoFocus
                />
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
