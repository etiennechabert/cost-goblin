import { useState } from 'react';
import { CalendarIcon, ChevronDown } from 'lucide-react';
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

  function formatHourBound(hour: HourString): string {
    // "2026-04-30 14:00:00" → "Apr 30 14:00"
    const s = String(hour);
    const date = new Date(`${s.slice(0, 10)}T${s.slice(11, 16)}:00`);
    if (Number.isNaN(date.getTime())) return s;
    const month = date.toLocaleString('en-US', { month: 'short' });
    return `${month} ${String(date.getDate())} ${s.slice(11, 16)}`;
  }

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

  function handlePreset(preset: Preset) {
    const range = getPresetRange(preset);
    // Picking a preset is an explicit "back to whole-day mode" gesture —
    // don't carry a previous drag's hour bounds onto the new window.
    onChange(range, resolveGranularity(range, preset.granularity));
    setShowCustom(false);
    setOpen(false);
  }

  function handleCustomRange(range: DateRange) {
    // Same intent as a preset: editing the calendar picks whole days, so any
    // active hour bounds no longer apply.
    onChange(range, resolveGranularity(range, granularity));
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
              !hourlyAvailable ? 'opacity-50 cursor-not-allowed' : '',
            ].join(' ')}
          >
            Hourly
          </button>
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
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
      <PopoverContent className="w-64 p-0" align="end">
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
              <div className="px-3 pb-3 flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-text-muted">From</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-2 rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary hover:border-accent transition-colors"
                      >
                        <CalendarIcon className="h-3 w-3 text-text-muted" />
                        {value.start}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start" side="left">
                      <Calendar
                        mode="single"
                        selected={new Date(value.start + 'T00:00:00')}
                        onSelect={(date) => {
                          if (date) {
                            handleCustomRange({ start: asDateString(date.toISOString().slice(0, 10)), end: value.end });
                          }
                        }}
                        disabled={(date) => date.toISOString().slice(0, 10) > latestDate}
                        autoFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-text-muted">To</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-2 rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary hover:border-accent transition-colors"
                      >
                        <CalendarIcon className="h-3 w-3 text-text-muted" />
                        {value.end}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start" side="left">
                      <Calendar
                        mode="single"
                        selected={new Date(value.end + 'T00:00:00')}
                        onSelect={(date) => {
                          if (date) {
                            handleCustomRange({ start: value.start, end: asDateString(date.toISOString().slice(0, 10)) });
                          }
                        }}
                        disabled={(date) => date.toISOString().slice(0, 10) > latestDate}
                        autoFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
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
