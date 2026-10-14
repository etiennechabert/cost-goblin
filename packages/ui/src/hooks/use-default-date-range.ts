import { useCallback, useState } from 'react';
import { getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange } from '../components/date-range-picker.js';
import type { LagDaysState } from './use-lag-days.js';

type RangeState =
  /** The default window, computed for `seededWith` (the lag in force then). */
  | { readonly source: 'default'; readonly range: DateRange; readonly seededWith: LagDaysState }
  /** Set through the setter: a user pick, or a range the view restored. */
  | { readonly source: 'set'; readonly range: DateRange };

/** A view's committed date range, starting at the default window for `lag`
 *  (from useLagDays — hand its `lagDays` to the DateRangePicker too, so the
 *  presets and the range agree).
 *
 *  The configured lag is read after the first render, which therefore seeds
 *  the default for DEFAULT_LAG_DAYS. Left at that, a longer configured lag
 *  would open the view on a window ending inside the incomplete days the lag
 *  exists to exclude. So when the configured lag lands, the default is
 *  re-seeded for it — once, during render (no commit shows the range and the
 *  picker out of step), and only while the range is still that default: a
 *  range set through the returned setter (a user pick, or one the view
 *  restored) is never overwritten.
 *
 *  The third element is true once the range has been set. Until then the
 *  range is a default, seeded or re-seeded, which a view must not persist as
 *  if it had been chosen. */
export function useDefaultDateRange(lag: LagDaysState): readonly [DateRange, (range: DateRange) => void, boolean] {
  const [state, setState] = useState<RangeState>(() => ({
    source: 'default',
    range: getDefaultDateRange(lag.lagDays),
    seededWith: lag,
  }));

  if (state.source === 'default' && !state.seededWith.loaded && lag.loaded) {
    setState({
      source: 'default',
      // The configured lag is usually the default one: keep the seeded object
      // then, so nothing keyed on the range re-runs.
      range: lag.lagDays === state.seededWith.lagDays ? state.range : getDefaultDateRange(lag.lagDays),
      seededWith: lag,
    });
  }

  const setRange = useCallback((range: DateRange) => {
    setState({ source: 'set', range });
  }, []);

  return [state.range, setRange, state.source === 'set'];
}
