import { useState } from 'react';
import type { DateString } from '@costgoblin/core/browser';
import { asDateString } from '@costgoblin/core/browser';

export type Granularity = 'daily' | 'hourly';

const DAILY_PRESETS = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '365 days', days: 365 },
];

const HOURLY_PRESETS = [
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
];

function daysAgo(days: number): DateString {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return asDateString(d.toISOString().slice(0, 10));
}

export interface DateRange {
  start: DateString;
  end: DateString;
}

interface DateRangePickerProps {
  value: DateRange;
  granularity: Granularity;
  onChange: (range: DateRange, granularity: Granularity) => void;
  /** Hide the "Hourly" preset row. Used by views that only query the
   *  daily tier (Explorer), where offering hourly presets would lead to
   *  empty result sets. */
  hideHourly?: boolean;
}

export function getDefaultDateRange(): DateRange {
  return { start: daysAgo(31), end: daysAgo(1) };
}

export function DateRangePicker({ value, granularity, onChange, hideHourly }: DateRangePickerProps) {
  const [showCustom, setShowCustom] = useState(false);
  const yesterday = daysAgo(1);

  function isActive(days: number): boolean {
    return value.start === daysAgo(days + 1) && value.end === yesterday;
  }

  function handlePreset(days: number, g: Granularity) {
    setShowCustom(false);
    onChange({ start: daysAgo(days + 1), end: yesterday }, g);
  }

  function handleCustomToggle() {
    setShowCustom(prev => !prev);
  }

  const isCustom = granularity === 'daily' && !DAILY_PRESETS.some(p => isActive(p.days))
    && !showCustom;

  return (
    <div className="flex flex-col items-end gap-1">
      {/* Daily row */}
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
        <span className="text-[10px] text-text-muted px-1.5">Daily</span>
        {DAILY_PRESETS.map(preset => (
          <button
            key={preset.days}
            type="button"
            onClick={() => { handlePreset(preset.days, 'daily'); }}
            className={[
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              granularity === 'daily' && isActive(preset.days)
                ? 'bg-bg-secondary text-text-primary shadow-sm'
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
              ? 'bg-bg-secondary text-text-primary shadow-sm'
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
            onClick={() => { handlePreset(preset.days, 'hourly'); }}
            className={[
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              granularity === 'hourly' && isActive(preset.days)
                ? 'bg-bg-secondary text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {preset.label}
          </button>
        ))}
      </div>
      )}

      {/* Custom date inputs */}
      {showCustom && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={value.start}
            onChange={(e) => { onChange({ ...value, start: asDateString(e.target.value) }, 'daily'); }}
            className="rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
          />
          <span className="text-xs text-text-muted">–</span>
          <input
            type="date"
            value={value.end}
            onChange={(e) => { onChange({ ...value, end: asDateString(e.target.value) }, 'daily'); }}
            className="rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
          />
        </div>
      )}
    </div>
  );
}
