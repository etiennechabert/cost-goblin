import { useMemo, useState } from 'react';
import { asDateString } from '@costgoblin/core/browser';
import type {
  Dimension,
  DimensionId,
  EntityRef,
  FilterMap,
  TagValue,
  ViewSpec,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import {
  CostFocusDispatchProvider,
  CostFocusProvider,
  useCostFocusReducer,
} from '../hooks/use-cost-focus.js';
import {
  isEnvironmentDimension,
  isOwnerDimension,
  isProductDimension,
} from '../lib/dimensions.js';
import { FilterBar } from '../components/filter-bar.js';
import { FilterActiveBanner } from '../components/filter-active-banner.js';
import {
  DateRangePicker,
  getDefaultDateRange,
} from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';
import { WIDGET_REGISTRY } from '../widgets/registry.js';
import { widgetFlexBasis } from '../widgets/widget.js';

interface CustomViewProps {
  readonly spec: ViewSpec;
  readonly headerSubtitle?: string | undefined;
  readonly onEntityClick?: ((entity: EntityRef, dim: DimensionId) => void) | undefined;
}

function priorityFor(d: Dimension): number {
  if (isEnvironmentDimension(d)) return 0;
  if (isOwnerDimension(d)) return 1;
  if (isProductDimension(d)) return 2;
  if (!('tagName' in d)) return 3;
  return 4;
}

function previousRangeFor(dr: DateRange): DateRange {
  const periodDays = Math.round(
    (new Date(dr.end).getTime() - new Date(dr.start).getTime()) / (24 * 60 * 60 * 1000),
  ) + 1;
  const prevEnd = new Date(new Date(dr.start).getTime() - 24 * 60 * 60 * 1000);
  const prevStart = new Date(prevEnd.getTime() - (periodDays - 1) * 24 * 60 * 60 * 1000);
  return {
    start: asDateString(prevStart.toISOString().slice(0, 10)),
    end: asDateString(prevEnd.toISOString().slice(0, 10)),
  };
}

function CustomViewInner({ spec, headerSubtitle, onEntityClick }: CustomViewProps) {
  const api = useCostApi();
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [filters, setFilters] = useState<FilterMap>({});

  const dimensionsQuery = useQuery(() => api.getDimensions(), [api]);
  const rawDimensions: Dimension[] = dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];
  const dimensions = useMemo(
    () => [...rawDimensions].sort((a, b) => priorityFor(a) - priorityFor(b)),
    [rawDimensions],
  );

  const previousDateRange = useMemo(
    () => previousRangeFor(dateRange),
    [dateRange],
  );

  function handleSetFilter(dim: DimensionId, value: TagValue) {
    setFilters(prev => ({ ...prev, [dim]: value }));
  }

  function handleGetFilterValues(dimensionId: DimensionId, currentFilters: FilterMap): Promise<{ value: string; label: string; count: number }[]> {
    const plain: Record<string, string> = {};
    for (const [k, v] of Object.entries(currentFilters)) if (v !== undefined) plain[k] = v;
    return api.getFilterValues(dimensionId, plain, dateRange);
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{spec.name}</h2>
          {headerSubtitle !== undefined && (
            <p className="text-sm text-text-secondary mt-0.5">{headerSubtitle}</p>
          )}
        </div>
        <DateRangePicker
          value={dateRange}
          granularity={granularity}
          onChange={(range, g) => { setDateRange(range); setGranularity(g); }}
        />
      </div>

      {dimensions.length > 0 && (
        <FilterBar
          dimensions={dimensions}
          filters={filters}
          onFilterChange={setFilters}
          getFilterValues={handleGetFilterValues}
        />
      )}

      <FilterActiveBanner />

      {dimensionsQuery.status === 'loading' && (
        <div className="text-sm text-text-secondary">Loading...</div>
      )}

      {spec.rows.map((row, rIdx) => (
        <div key={rIdx} className="flex gap-4 items-stretch min-w-0">
          {row.widgets.map((w) => {
            const Renderer = WIDGET_REGISTRY[w.type];
            return (
              <div
                key={w.id}
                className="min-w-0 flex flex-col"
                style={{ flexBasis: widgetFlexBasis(w.size), flexGrow: 1, flexShrink: 1 }}
              >
                <Renderer
                  spec={w}
                  dateRange={dateRange}
                  previousDateRange={previousDateRange}
                  granularity={granularity}
                  globalFilters={filters}
                  dimensions={dimensions}
                  onSetFilter={handleSetFilter}
                  onEntityClick={onEntityClick}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function CustomView(props: CustomViewProps) {
  const [state, dispatch] = useCostFocusReducer();
  return (
    <CostFocusProvider value={state}>
      <CostFocusDispatchProvider value={dispatch}>
        <CustomViewInner {...props} />
      </CostFocusDispatchProvider>
    </CostFocusProvider>
  );
}
