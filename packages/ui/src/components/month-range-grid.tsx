import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DateString } from '@costgoblin/core/browser';
import { asDateString, periodEnd, periodStart } from '@costgoblin/core/browser';

interface MonthRange {
  readonly start: DateString;
  readonly end: DateString;
}

interface MonthRangeGridProps {
  readonly value: MonthRange;
  /** The newest day with data: the months after its month cannot be picked. */
  readonly newestDay: DateString;
  readonly onSelect: (range: MonthRange) => void;
}

const MONTH_NAMES: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function yearOf(day: DateString): number {
  return Number(day.slice(0, 4));
}

/** The first day of month `index` (0 to 11) of `year`. */
function monthStart(year: number, index: number): DateString {
  return asDateString(`${String(year).padStart(4, '0')}-${String(index + 1).padStart(2, '0')}-01`);
}

/** A 12-month grid for one year, paged by year arrows. The first click picks a
 *  start month, the second the end month (in either order); the result runs
 *  from the first day of the earlier month to the last day of the later one. */
export function MonthRangeGrid({ value, newestDay, onSelect }: MonthRangeGridProps) {
  const [year, setYear] = useState(() => yearOf(value.end));
  // The month (as its first day) picked first, while the second click is pending.
  const [pending, setPending] = useState<DateString | null>(null);
  const newestMonth = periodStart(newestDay, 'monthly');

  function handleMonth(first: DateString) {
    if (pending === null) {
      setPending(first);
      return;
    }
    const [earlier, later] = first < pending ? [first, pending] : [pending, first];
    setPending(null);
    onSelect({ start: earlier, end: periodEnd(later, 'monthly') });
  }

  function isSelected(first: DateString): boolean {
    if (pending !== null) return first === pending;
    return first >= periodStart(value.start, 'monthly') && first <= periodStart(value.end, 'monthly');
  }

  return (
    <div className="px-3 pt-1 pb-1">
      <div className="flex items-center justify-between pb-2">
        <button
          type="button"
          aria-label="Previous year"
          onClick={() => { setYear(prev => prev - 1); }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:text-text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-text-primary">{String(year)}</span>
        <button
          type="button"
          aria-label="Next year"
          disabled={year >= yearOf(newestMonth)}
          onClick={() => { setYear(prev => prev + 1); }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {MONTH_NAMES.map((name, index) => {
          const first = monthStart(year, index);
          const available = first <= newestMonth;
          const selected = isSelected(first);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={selected}
              disabled={!available}
              onClick={() => { handleMonth(first); }}
              className={[
                'rounded-md px-2 py-2 text-xs transition-colors',
                selected
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary',
                available ? '' : 'opacity-50 cursor-not-allowed',
              ].join(' ')}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
