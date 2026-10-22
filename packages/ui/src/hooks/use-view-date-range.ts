import { useState } from 'react';
import { getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange } from '../components/date-range-picker.js';
import { useLagDays } from './use-lag-days.js';

export interface ViewDateRange {
  /** The cost scope's freshness lag: DEFAULT_LAG_DAYS until it loads. */
  readonly lagDays: number;
  readonly dateRange: DateRange;
  /** The range the view set itself (a pick, a restored preference), or null
   *  while `dateRange` is the default window. Key preference saves on this:
   *  the default moving to the loaded lag is not a change to persist. */
  readonly pickedRange: DateRange | null;
  readonly setDateRange: (range: DateRange) => void;
}

/** A view's date range. It starts as the "Last 30 days" window ending
 *  `lagDays` ago, but the lag comes from the cost scope, which loads after
 *  the first render: until the view sets a range of its own (a pick, a
 *  restored preference), the window moves to the lag once it arrives. */
export function useViewDateRange(): ViewDateRange {
  const lagDays = useLagDays();
  const [fallback, setFallback] = useState(() => ({ lagDays, range: getDefaultDateRange(lagDays) }));
  const [pickedRange, setPickedRange] = useState<DateRange | null>(null);
  // Kept in state, not recomputed per render, so the range keeps its identity
  // (views key effects and queries on it) until the lag changes.
  if (fallback.lagDays !== lagDays) {
    setFallback({ lagDays, range: getDefaultDateRange(lagDays) });
  }
  return { lagDays, dateRange: pickedRange ?? fallback.range, pickedRange, setDateRange: setPickedRange };
}
