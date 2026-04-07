import { useState } from 'react';
import type { DateString } from '@costgoblin/core/browser';
import { asDateString } from '@costgoblin/core/browser';

type PresetKey = '7d' | '30d' | '90d' | '365d' | 'custom';

const PRESETS: { key: PresetKey; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '365d', label: '365 days', days: 365 },
];

function daysAgo(days: number): DateString {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return asDateString(d.toISOString().slice(0, 10));
}

function today(): DateString {
  return asDateString(new Date().toISOString().slice(0, 10));
}

export interface DateRange {
  start: DateString;
  end: DateString;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

export function getDefaultDateRange(): DateRange {
  return { start: daysAgo(30), end: today() };
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [showCustom, setShowCustom] = useState(false);

  const activePreset = PRESETS.find((p) => {
    const expected = daysAgo(p.days);
    return value.start === expected && value.end === today();
  });

  function handlePreset(preset: typeof PRESETS[number]) {
    setShowCustom(false);
    onChange({ start: daysAgo(preset.days), end: today() });
  }

  function handleCustomToggle() {
    setShowCustom((prev) => !prev);
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            onClick={() => { handlePreset(preset); }}
            className={[
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              activePreset?.key === preset.key
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
            activePreset === undefined
              ? 'bg-bg-secondary text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary',
          ].join(' ')}
        >
          Custom
        </button>
      </div>

      {showCustom && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={value.start}
            onChange={(e) => { onChange({ ...value, start: asDateString(e.target.value) }); }}
            className="rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
          />
          <span className="text-xs text-text-muted">–</span>
          <input
            type="date"
            value={value.end}
            onChange={(e) => { onChange({ ...value, end: asDateString(e.target.value) }); }}
            className="rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
          />
        </div>
      )}

      {activePreset === undefined && !showCustom && (
        <span className="text-xs text-text-muted">
          {value.start} – {value.end}
        </span>
      )}
    </div>
  );
}
