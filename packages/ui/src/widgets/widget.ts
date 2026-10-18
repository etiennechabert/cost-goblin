import type { ComponentType } from 'react';
import type {
  CostResult,
  DateRange,
  DailyCostDay,
  DailyCostsResult,
  Dimension,
  DimensionId,
  EntityRef,
  FilterMap,
  Granularity,
  SummaryMetric,
  TagValue,
  WidgetSize,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { asDimensionId } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';
import { daysBetween } from '../lib/dates.js';

const DIMENSION_FALLBACK_CHAINS: ReadonlyMap<DimensionId, readonly DimensionId[]> = new Map([
  [asDimensionId('service'), [asDimensionId('service_category'), asDimensionId('sku_meter')]],
  [asDimensionId('service_category'), [asDimensionId('service'), asDimensionId('sku_meter')]],
]);

// Fallback candidates are built-in canonical columns — always queryable regardless of enabled state.
export function getDimensionFallbacks(dimId: DimensionId): readonly DimensionId[] {
  return DIMENSION_FALLBACK_CHAINS.get(dimId) ?? [];
}

/** Props every widget renderer receives. The host view owns the global
 *  FilterBar/DateRangePicker; each widget owns its own data fetching and
 *  renders inside the size lane the host allocated. */
export interface WidgetCommonProps {
  readonly spec: WidgetSpec;
  readonly dateRange: DateRange;
  /** Date range covering the prior comparable period — used by widgets that
   *  need a delta (summary, trends-style charts). The host computes it. */
  readonly previousDateRange: DateRange;
  /** When true, widgets should query the previous period and render
   *  comparison overlays (delta %, ghost lines, etc.). */
  readonly compareEnabled: boolean;
  readonly granularity: Granularity;
  readonly globalFilters: FilterMap;
  readonly dimensions: readonly Dimension[];
  readonly onSetFilter: (dim: DimensionId, value: TagValue) => void;
  readonly onEntityClick?: ((entity: EntityRef, dim: DimensionId) => void) | undefined;
  /** Optional callback letting widgets request a new visible range — used by
   *  drag-to-zoom interactions. Granularity is omitted when the widget has
   *  no opinion (caller keeps the current setting). */
  readonly onDateRangeChange?: ((range: DateRange, granularity?: Granularity) => void) | undefined;
}

export type WidgetComponent = ComponentType<WidgetCommonProps>;

const SIZE_TO_FRACTION: Readonly<Record<WidgetSize, number>> = {
  small: 1,
  medium: 2,
  large: 3,
  full: 4,
};

/** Render a widget across the given fraction of a 4-column row. Tailwind has
 *  no `col-span-N/N` utility for arbitrary fractions; use percentage flex
 *  basis and let the row be a flexbox. */
export function widgetFlexBasis(size: WidgetSize): string {
  const frac = SIZE_TO_FRACTION[size];
  return `${((frac / 4) * 100).toFixed(2)}%`;
}

/** Stable key for a FilterMap. Used as a useQuery dep so widgets refetch on
 *  filter changes. Tiny objects, JSON.stringify is cheap enough. */
export function filtersKey(filters: FilterMap): string {
  return JSON.stringify(filters);
}

const SUMMARY_DEFAULT_GROUP_BY = asDimensionId('service');

/** Whether a summary metric ranks or counts the values of a dimension. */
export function summaryUsesGroupBy(metric: SummaryMetric | undefined): boolean {
  return metric === 'topEntity' || metric === 'entityCount';
}

/** The dimension a summary's `topEntity` / `entityCount` reads: its own
 *  `groupBy`, else `service`, which every provider's data carries. */
export function summaryGroupBy(groupBy: DimensionId | undefined): DimensionId {
  return groupBy ?? SUMMARY_DEFAULT_GROUP_BY;
}

/** Resolve a DimensionId to a user-facing label, falling back to the id. */
export function dimensionLabelFor(dimensions: readonly Dimension[], id: DimensionId): string {
  const dim = dimensions.find(d => getDimensionId(d) === id);
  return dim === undefined ? id : getDimensionLabel(dim);
}

const COVERAGE_THRESHOLD = 0.8;

/** Returns true if a CostResult's synced data covers at least 80% of the
 *  requested date range. The main process reports the covered days; a result
 *  without them counts its `dateRange` as covered. */
export function hasSufficientCoverage(result: CostResult, requested: DateRange): boolean {
  const requestedDays = daysBetween(requested.start, requested.end);
  const actualDays = result.coveredDays ?? daysBetween(result.dateRange.start, result.dateRange.end);
  return actualDays >= requestedDays * COVERAGE_THRESHOLD;
}

/** Returns true if a DailyCostsResult's synced data covers at least 80% of
 *  the requested date range. The main process reports the covered days, since
 *  `days` leaves out the days with no spend; a result without them counts
 *  `days`. */
export function hasSufficientDailyCoverage(result: DailyCostsResult, requested: DateRange): boolean {
  const requestedDays = daysBetween(requested.start, requested.end);
  const actualDays = result.coveredDays ?? result.days.length;
  return actualDays >= requestedDays * COVERAGE_THRESHOLD;
}

/** UTC epoch ms of a daily-costs date key (`YYYY-MM-DD`, or the hourly tier's
 *  `YYYY-MM-DD HH:00`) or of a range's `startHour` (`YYYY-MM-DD HH:00:00`).
 *  These are data keys, not calendar Dates: the arithmetic stays in UTC. */
function dateKeyMs(key: string): number {
  return key.length > 10
    ? Date.parse(`${key.slice(0, 10)}T${key.slice(11, 13)}:00:00Z`)
    : Date.parse(`${key}T00:00:00Z`);
}

function dateKeyAt(ms: number, hourly: boolean): string {
  const iso = new Date(ms).toISOString();
  return hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10);
}

/** Finds the previous period's day that lines up with a current-period date:
 *  the one at the same offset from its period's start, day for day or, on the
 *  hourly tier, hour for hour. The two periods have the same length, but the
 *  main process lists only the days that returned rows, so their positions
 *  in `days` don't match. */
export function previousDayLookup(
  previous: DailyCostsResult,
  previousRange: DateRange,
  currentRange: DateRange,
): (date: string) => DailyCostDay | undefined {
  const byDate = new Map<string, DailyCostDay>(previous.days.map(d => [d.date, d]));
  const shift = dateKeyMs(currentRange.startHour ?? currentRange.start) - dateKeyMs(previousRange.startHour ?? previousRange.start);
  return date => {
    const ms = dateKeyMs(date) - shift;
    return Number.isNaN(ms) ? undefined : byDate.get(dateKeyAt(ms, date.length > 10));
  };
}
