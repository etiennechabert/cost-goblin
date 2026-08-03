import type { ComponentType } from 'react';
import type {
  CostResult,
  DateRange,
  DailyCostsResult,
  Dimension,
  DimensionId,
  EntityRef,
  FilterMap,
  Granularity,
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

/** Resolve a DimensionId to a user-facing label, falling back to the id. */
export function dimensionLabelFor(dimensions: readonly Dimension[], id: DimensionId): string {
  const dim = dimensions.find(d => getDimensionId(d) === id);
  return dim === undefined ? id : getDimensionLabel(dim);
}

const COVERAGE_THRESHOLD = 0.8;

/** Returns true if a CostResult covers at least 80% of the requested date range. */
export function hasSufficientCoverage(result: CostResult, requested: DateRange): boolean {
  const requestedDays = daysBetween(requested.start, requested.end);
  const actualDays = daysBetween(result.dateRange.start, result.dateRange.end);
  return actualDays >= requestedDays * COVERAGE_THRESHOLD;
}

/** Returns true if a DailyCostsResult covers at least 80% of the requested date range. */
export function hasSufficientDailyCoverage(result: DailyCostsResult, requested: DateRange): boolean {
  const requestedDays = daysBetween(requested.start, requested.end);
  return result.days.length >= requestedDays * COVERAGE_THRESHOLD;
}
