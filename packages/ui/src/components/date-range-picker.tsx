import { useState } from 'react';
import { CalendarIcon } from 'lucide-react';
import type { DateString } from '@costgoblin/core/browser';
import { DEFAULT_LAG_DAYS, asDateString } from '@costgoblin/core/browser';
import { daysAgo, getThisMonth, getLastMonth, getLastQuarter, getYTD } from '../lib/dates.js';
import { Calendar } from './ui/calendar.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { Button } from './ui/button.js';

export type Granularity = 'daily' | 'hourly';

type DayPreset = {
  readonly label: string;
  readonly type: 'days';
  readonly days: number;
};

type CalendarPreset = {
  readonly label: string;
  readonly type: 'calendar';
  readonly getRange: (lagDays: number) => { start: DateString; end: DateString };
};

type Preset = DayPreset | CalendarPreset;

const DAILY_PRESETS: readonly Preset[] = [
  { label: 'Last 7d', type: 'days', days: 7 },
  { label: 'Last 30d', type: 'days', days: 30 },
  { label: 'This month', type: 'calendar', getRange: (lagDays) => {
    const range = getThisMonth();
    return { ...range, end: lagDays > 0 ? daysAgo(lagDays) : range.end };
  }},
  { label: 'Last month', type: 'calendar', getRange: () => getLastMonth() },
  { label: 'Last quarter', type: 'calendar', getRange: () => getLastQuarter() },
  { label: 'YTD', type: 'calendar', getRange: (lagDays) => {
    const range = getYTD();
    return { ...range, end: lagDays > 0 ? daysAgo(lagDays) : range.end };
  }},
];

const HOURLY_PRESETS = [
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
];

export interface DateRange {
  start: DateString;
  end: DateString;
}

interface DateRangePickerProps {
  readonly value: DateRange;
  readonly granularity: Granularity;
  readonly onChange: (range: DateRange, granularity: Granularity) => void;
  /** Hide the "Hourly" preset row. Used by views that only query the
   *  daily tier (Explorer), where offering hourly presets would lead to
   *  empty result sets. */
  readonly hideHourly?: boolean;
  /** Number of most-recent days excluded from ranges. */
  readonly lagDays?: number;
}

export function getDefaultDateRange(lagDays: number = DEFAULT_LAG_DAYS): DateRange {
  return { start: daysAgo(30 + lagDays), end: daysAgo(lagDays) };
}

export function DateRangePicker({ value, granularity, onChange, hideHourly, lagDays = DEFAULT_LAG_DAYS }: DateRangePickerProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const latestDate = daysAgo(lagDays);

  function getPresetRange(preset: Preset): DateRange {
    if (preset.type === 'days') {
      return { start: daysAgo(preset.days + lagDays), end: latestDate };
    }
    return preset.getRange(lagDays);
  }

  function isActivePreset(preset: Preset): boolean {
    const range = getPresetRange(preset);
    return value.start === range.start && value.end === range.end;
  }

  function isActiveHourly(days: number): boolean {
    return value.start === daysAgo(days + lagDays) && value.end === latestDate;
  }

  function handleDailyPreset(preset: Preset) {
    setShowCustom(false);
    const range = getPresetRange(preset);
    onChange(range, 'daily');
  }

  function handleHourlyPreset(days: number) {
    setShowCustom(false);
    onChange({ start: daysAgo(days + lagDays), end: latestDate }, 'hourly');
  }

  function handleCustomToggle() {
    setShowCustom(prev => !prev);
  }

  const isCustom = granularity === 'daily' && !DAILY_PRESETS.some(p => isActivePreset(p))
    && !showCustom;

  return (
    <div className="flex flex-col items-end gap-1">
      {/* Daily row */}
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
        <span className="text-[10px] text-text-muted px-1.5">Daily</span>
        {DAILY_PRESETS.map(preset => (
          <button
            key={preset.label}
            type="button"
            onClick={() => { handleDailyPreset(preset); }}
            className={[
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              granularity === 'daily' && isActivePreset(preset)
                ? 'bg-accent text-bg-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={handleCustomToggle}
          className={[
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            isCustom || showCustom
              ? 'bg-accent text-bg-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary',
          ].join(' ')}
        >
          Custom
        </button>
      </div>

      {/* Hourly row */}
      {hideHourly !== true && (
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
        <span className="text-[10px] text-text-muted px-1.5">Hourly</span>
        {HOURLY_PRESETS.map(preset => (
          <button
            key={preset.days}
            type="button"
            onClick={() => { handleHourlyPreset(preset.days); }}
            className={[
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              granularity === 'hourly' && isActiveHourly(preset.days)
                ? 'bg-accent text-bg-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {preset.label}
          </button>
        ))}
      </div>
      )}

      {/* Custom date picker with Calendar */}
      {showCustom && (
        <div className="flex items-center gap-1.5">
          <Popover open={startOpen} onOpenChange={setStartOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="justify-start text-left font-normal"
              >
                <CalendarIcon className="mr-2 h-3 w-3" />
                <span className="text-xs">{value.start}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={new Date(value.start)}
                onSelect={(date) => {
                  if (date) {
                    const dateStr = asDateString(date.toISOString().slice(0, 10));
                    onChange({ ...value, start: dateStr }, 'daily');
                    setStartOpen(false);
                  }
                }}
                disabled={(date) => {
                  const dateStr = date.toISOString().slice(0, 10);
                  return dateStr > latestDate;
                }}
                autoFocus
              />
            </PopoverContent>
          </Popover>
          <span className="text-xs text-text-muted">–</span>
          <Popover open={endOpen} onOpenChange={setEndOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="justify-start text-left font-normal"
              >
                <CalendarIcon className="mr-2 h-3 w-3" />
                <span className="text-xs">{value.end}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={new Date(value.end)}
                onSelect={(date) => {
                  if (date) {
                    const dateStr = asDateString(date.toISOString().slice(0, 10));
                    onChange({ ...value, end: dateStr }, 'daily');
                    setEndOpen(false);
                  }
                }}
                disabled={(date) => {
                  const dateStr = date.toISOString().slice(0, 10);
                  return dateStr > latestDate;
                }}
                autoFocus
              />
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
