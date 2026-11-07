import type { ComponentType } from 'react';
import type {
  CostResult,
  DateRange,
  DailyCostsResult,
  Dimension,
  DimensionId,
  DimensionsConfig,
  EntityRef,
  FilterMap,
  Granularity,
  TagValue,
  WidgetSize,
  WidgetSpec,
  WidgetType,
} from '@costgoblin/core/browser';
import { asDimensionId, countPeriods, isPeriodGranularity } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';
import { daysBetween } from '../lib/dates.js';

/** Where a chart grouped by a dimension drills down to. No workspace has all of
 *  these: a GCP-only one has no Service Category or SKU Meter, and an AWS-only
 *  one no Description. */
const DIMENSION_DRILL_DOWNS: ReadonlyMap<DimensionId, readonly DimensionId[]> = new Map([
  [asDimensionId('service'), [asDimensionId('service_category'), asDimensionId('sku_meter'), asDimensionId('description')]],
  [asDimensionId('service_category'), [asDimensionId('service'), asDimensionId('sku_meter'), asDimensionId('description')]],
]);

/** What a drill-down falls through to: every provider fills these, and they are
 *  low-cardinality enough to chart. */
const GENERAL_SPLITS: readonly DimensionId[] = [asDimensionId('account'), asDimensionId('region')];

/** The group-by of a query read only for its totals, which no grouping
 *  changes. Service is locked on, so it is always in the rollup grain; a
 *  dimension the user can disable (Account) would read the raw Parquet. */
export const TOTALS_GROUP_BY: DimensionId = asDimensionId('service');

/** Whether a chart grouped by `dimId` has anywhere to go when the filters leave
 *  it a single value. Saves reading the config for one that never does. */
export function hasDimensionFallbacks(dimId: DimensionId): boolean {
  return DIMENSION_DRILL_DOWNS.has(dimId);
}

/** What a chart grouped by `dimId` tries, in order, when the filters leave it a
 *  single value, as clicking one does. Only dimensions in `config`: main refuses
 *  any other. A drill-down counts even when disabled, since SKU Meter and
 *  Description are off by default, but a general split doesn't: charts stay off
 *  a dimension the user turned off (see enabledGroupBys). */
export function getDimensionFallbacks(dimId: DimensionId, config: DimensionsConfig): readonly DimensionId[] {
  const drillDowns = DIMENSION_DRILL_DOWNS.get(dimId);
  if (drillDowns === undefined) return [];
  const builtIns = new Map(config.builtIn.map(d => [d.name, d]));
  return [
    ...drillDowns.filter(id => builtIns.has(id)),
    ...GENERAL_SPLITS.filter(id => {
      const split = builtIns.get(id);
      return split !== undefined && split.enabled !== false;
    }),
  ];
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

/** The widget types with a Top N setting: they rank their entries and show
 *  only the first N. */
export type TopNWidgetType = {
  [T in WidgetType]: 'topN' extends keyof Extract<WidgetSpec, { readonly type: T }> ? T : never;
}[WidgetType];

export type TopNWidgetSpec = Extract<WidgetSpec, { readonly type: TopNWidgetType }>;

/** How many entries each ranked widget shows when its spec sets no Top N.
 *  The widgets and the views editor both read it, so what the editor shows is
 *  what the widget draws. */
export const DEFAULT_TOP_N: Readonly<Record<TopNWidgetType, number>> = {
  line: 6,
  topNBar: 12,
  heatmap: 12,
  baseline: 8,
  waterfall: 8,
  priceVolume: 6,
};

export function isTopNWidget(spec: WidgetSpec): spec is TopNWidgetSpec {
  return Object.hasOwn(DEFAULT_TOP_N, spec.type);
}

/** The Top N a widget of `type` draws for `spec`: the spec's own, else the
 *  type's default. */
export function topNFor(spec: WidgetSpec, type: TopNWidgetType): number {
  return (isTopNWidget(spec) && spec.type === type ? spec.topN : undefined) ?? DEFAULT_TOP_N[type];
}

const SIZE_TO_FRACTION: Readonly<Record<WidgetSize, number>> = {
  small: 1,
  medium: 2,
  large: 3,
  full: 4,
};

/** The narrowest a widget gets before its row wraps it onto a new line. The
 *  row's width depends on the window and on what sits beside the dashboard,
 *  so a share of it alone can leave a widget too narrow to read. */
const SIZE_TO_MIN_WIDTH: Readonly<Record<WidgetSize, string>> = {
  small: '14rem',
  medium: '19rem',
  large: '20rem',
  full: '0',
};

export interface WidgetFlex {
  readonly flexGrow: number;
  readonly flexShrink: number;
  readonly flexBasis: string;
  readonly minWidth: string;
}

/** Lay a widget out in its (wrapping, flex) row, out of 4 columns. A row that
 *  fills them or more (three mediums) shares its width by size from a zero
 *  basis, so it still fits on one line, as it did when widgets only shrank. A
 *  row short of them keeps each widget's share as its basis and splits what is
 *  left evenly, as before. Either way a row wraps only once a widget would get
 *  narrower than its minimum, and a widget alone on a line fills it. */
export function widgetFlex(size: WidgetSize, rowSizes: readonly WidgetSize[]): WidgetFlex {
  const minWidth = SIZE_TO_MIN_WIDTH[size];
  const rowColumns = rowSizes.reduce((n, s) => n + SIZE_TO_FRACTION[s], 0);
  if (rowColumns < 4) {
    return { flexGrow: 1, flexShrink: 1, flexBasis: `${String(SIZE_TO_FRACTION[size] * 25)}%`, minWidth };
  }
  return { flexGrow: SIZE_TO_FRACTION[size], flexShrink: 1, flexBasis: '0%', minWidth };
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

/** Returns true if a DailyCostsResult covers at least 80% of the requested date range.
 *  A weekly or monthly result has one bucket per period, so it is measured
 *  against the number of periods the range touches, not its days. */
export function hasSufficientDailyCoverage(
  result: DailyCostsResult,
  requested: DateRange,
  granularity?: Granularity,
): boolean {
  if (granularity !== undefined && isPeriodGranularity(granularity)) {
    return result.days.length >= countPeriods(requested, granularity) * COVERAGE_THRESHOLD;
  }
  const requestedDays = daysBetween(requested.start, requested.end);
  return result.days.length >= requestedDays * COVERAGE_THRESHOLD;
}
