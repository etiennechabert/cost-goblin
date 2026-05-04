import { useEffect, useMemo, useRef, useState } from 'react';
import { asDateString, asTagValue } from '@costgoblin/core/browser';
import { daysBetween } from '../lib/dates.js';
import type {
  Dimension,
  DimensionId,
  EntityRef,
  FilterMap,
  TagValue,
  ViewSpec,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
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
  readonly initialFilter?: FilterMap | undefined;
}

function priorityFor(d: Dimension): number {
  if (isEnvironmentDimension(d)) return 0;
  if (isOwnerDimension(d)) return 1;
  if (isProductDimension(d)) return 2;
  if (!('tagName' in d)) return 3;
  return 4;
}

function previousRangeFor(dr: DateRange): DateRange {
  const periodDays = daysBetween(dr.start, dr.end);
  const prevEnd = new Date(new Date(dr.start).getTime() - 24 * 60 * 60 * 1000);
  const prevStart = new Date(prevEnd.getTime() - (periodDays - 1) * 24 * 60 * 60 * 1000);
  return {
    start: asDateString(prevStart.toISOString().slice(0, 10)),
    end: asDateString(prevEnd.toISOString().slice(0, 10)),
  };
}

function CustomViewInner({ spec, headerSubtitle, initialFilter }: CustomViewProps) {
  const api = useCostApi();
  const lagDays = useLagDays();
  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [filters, setFilters] = useState<FilterMap>(initialFilter ?? {});
  const prefsLoadedRef = useRef(false);
  const columnPrefsRef = useRef<{ hiddenColumns: readonly string[]; columnOrder: readonly string[] }>({
    hiddenColumns: [],
    columnOrder: [],
  });

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

  // Cancel in-flight DuckDB queries when the date range or granularity
  // changes so stale 30d queries don't compete for memory with new 365d
  // queries. Skip until one render AFTER preferences have loaded — the
  // prefs restore itself triggers a state change that we must not cancel.
  const cancelReadyRef = useRef(false);
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    if (!cancelReadyRef.current) {
      cancelReadyRef.current = true;
      return;
    }
    api.cancelPendingQueries().catch(() => undefined);
  }, [dateRange, granularity, api]);

  // Load persisted date range and granularity on mount
  useEffect(() => {
    api.getExplorerPreferences().then(prefs => {
      // Store column preferences to preserve them when saving
      columnPrefsRef.current = {
        hiddenColumns: prefs.hiddenColumns,
        columnOrder: prefs.columnOrder,
      };
      if (prefs.lastUsedDateRange !== undefined) {
        setDateRange(prefs.lastUsedDateRange);
      }
      if (prefs.lastUsedGranularity !== undefined) {
        setGranularity(prefs.lastUsedGranularity);
      }
      if (prefs.compareEnabled === true) {
        setCompareEnabled(true);
      }
      prefsLoadedRef.current = true;
    }).catch(() => {
      prefsLoadedRef.current = true;
    });
  }, [api]);

  // Save date range and granularity whenever they change. Skip saves until
  // after preferences have loaded — the prefsLoadedRef flag is set in the
  // mount effect once the initial load completes (or fails). This prevents
  // redundant writes when restoring persisted values on mount. Preserve
  // column preferences from Explorer to avoid overwriting them.
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    api.saveExplorerPreferences({
      hiddenColumns: columnPrefsRef.current.hiddenColumns,
      columnOrder: columnPrefsRef.current.columnOrder,
      lastUsedDateRange: dateRange,
      lastUsedGranularity: granularity,
      compareEnabled,
    }).catch(() => undefined);
  }, [dateRange, granularity, compareEnabled, api]);

  function handleSetFilter(dim: DimensionId, value: TagValue) {
    setFilters(prev => ({ ...prev, [dim]: [value] }));
  }

  function handleEntityClick(entity: EntityRef, dim: DimensionId) {
    handleSetFilter(dim, asTagValue(entity));
  }

  function handleGetFilterValues(dimensionId: DimensionId, currentFilters: FilterMap): Promise<{ value: string; label: string; count: number }[]> {
    const plain: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(currentFilters)) if (v !== undefined) plain[k] = v;
    return api.getFilterValues(dimensionId, plain, dateRange);
  }

  return (
    <div className="flex flex-col gap-6 p-6">
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
          lagDays={lagDays}
          compareEnabled={compareEnabled}
          onCompareChange={setCompareEnabled}
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

      {spec.rows.map((row) => (
        <div key={row.widgets.map(w => w.id).join('-')} className="flex gap-4 items-stretch min-w-0">
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
                  compareEnabled={compareEnabled}
                  granularity={granularity}
                  globalFilters={filters}
                  dimensions={dimensions}
                  onSetFilter={handleSetFilter}
                  onEntityClick={handleEntityClick}
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
