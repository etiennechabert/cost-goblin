import type { ComponentType } from 'react';
import type {
  DateRange,
  Dimension,
  DimensionId,
  EntityRef,
  FilterMap,
  Granularity,
  TagValue,
  WidgetFilterOverlay,
  WidgetSize,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';

/** Props every widget renderer receives. The host view owns the global
 *  FilterBar/DateRangePicker; each widget owns its own data fetching and
 *  renders inside the size lane the host allocated. */
export interface WidgetCommonProps {
  readonly spec: WidgetSpec;
  readonly dateRange: DateRange;
  /** Date range covering the prior comparable period — used by widgets that
   *  need a delta (summary, trends-style charts). The host computes it. */
  readonly previousDateRange: DateRange;
  readonly granularity: Granularity;
  readonly globalFilters: FilterMap;
  readonly dimensions: readonly Dimension[];
  readonly onSetFilter: (dim: DimensionId, value: TagValue) => void;
  readonly onEntityClick?: ((entity: EntityRef, dim: DimensionId) => void) | undefined;
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

/** Compose global filters with a widget's optional overlay. Overlay wins on
 *  conflict so a widget can pin a specific dimension while the FilterBar
 *  remains the user's primary control. */
export function mergeFilters(global: FilterMap, overlay?: WidgetFilterOverlay): FilterMap {
  return overlay === undefined ? global : { ...global, ...overlay };
}

/** Stable key for a FilterMap. Used as a useQuery dep so widgets refetch on
 *  filter changes. Tiny objects, JSON.stringify is cheap enough. */
export function filtersKey(filters: FilterMap): string {
  return JSON.stringify(filters);
}

/** Resolve a DimensionId to a user-facing label, falling back to the id. */
export function dimensionLabelFor(dimensions: readonly Dimension[], id: DimensionId): string {
  const dim = dimensions.find(d => getDimensionId(d) === id);
  return dim !== undefined ? getDimensionLabel(dim) : id;
}
