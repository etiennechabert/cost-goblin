import { useState } from 'react';
import { CalendarIcon, ChevronDown } from 'lucide-react';
import type { DateString } from '@costgoblin/core/browser';
import { DEFAULT_LAG_DAYS, asDateString } from '@costgoblin/core/browser';
import { daysAgo, getThisMonth, getLastMonth, getCurrentQuarter, getLastQuarter, getYTD, getLastYear } from '../lib/dates.js';
import { Calendar } from './ui/calendar.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export type Granularity = 'daily' | 'hourly';

type DayPreset = {
  readonly label: string;
  readonly type: 'days';
  readonly days: number;
  readonly granularity: Granularity;
};

type CalendarPreset = {
  readonly label: string;
  readonly type: 'calendar';
  readonly getRange: () => { start: DateString; end: DateString };
  readonly granularity: Granularity;
};

type Preset = DayPreset | CalendarPreset;

const PRESETS: readonly { section: string; items: readonly Preset[] }[] = [
  {
    section: 'Daily',
    items: [
      { label: 'Last 30 days', type: 'days', days: 30, granularity: 'daily' },
      { label: 'Last 90 days', type: 'days', days: 90, granularity: 'daily' },
      { label: 'Last 180 days', type: 'days', days: 180, granularity: 'daily' },
      { label: 'Last 365 days', type: 'days', days: 365, granularity: 'daily' },
    ],
  },
  {
    section: 'Hourly',
    items: [
      { label: 'Last 7 days', type: 'days', days: 7, granularity: 'hourly' },
      { label: 'Last 14 days', type: 'days', days: 14, granularity: 'hourly' },
      { label: 'Last 28 days', type: 'days', days: 28, granularity: 'hourly' },
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
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const latestDate = daysAgo(lagDays);

  function getPresetRange(preset: Preset): DateRange {
    if (preset.type === 'days') {
      return { start: daysAgo(preset.days + lagDays), end: latestDate };
    }
    return preset.getRange();
  }

  function getActiveLabel(): string {
    let label: string | undefined;
    for (const preset of ALL_PRESETS) {
      const range = getPresetRange(preset);
      if (value.start === range.start && value.end === range.end && granularity === preset.granularity) {
        label = preset.label;
        break;
      }
    }
    const base = label ?? `${value.start} → ${value.end}`;
    return compareEnabled === true ? `${base} vs prev` : base;
  }

  function handlePreset(preset: Preset) {
    const range = getPresetRange(preset);
    onChange(range, preset.granularity);
    setShowCustom(false);
    setOpen(false);
  }

  function isActivePreset(preset: Preset): boolean {
    const range = getPresetRange(preset);
    return value.start === range.start && value.end === range.end && granularity === preset.granularity;
  }

  const sections = hideHourly === true
    ? PRESETS.filter(s => s.section !== 'Hourly')
    : PRESETS;

  return (
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
              {items.map(preset => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => { handlePreset(preset); }}
                  className={[
                    'w-full text-left px-3 py-1.5 text-xs transition-colors',
                    isActivePreset(preset)
                      ? 'bg-accent/10 text-accent font-medium border-l-2 border-accent'
                      : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary border-l-2 border-transparent',
                  ].join(' ')}
                >
                  {preset.label}
                </button>
              ))}
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
                            onChange({ ...value, start: asDateString(date.toISOString().slice(0, 10)) }, 'daily');
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
                            onChange({ ...value, end: asDateString(date.toISOString().slice(0, 10)) }, 'daily');
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
  );
}
