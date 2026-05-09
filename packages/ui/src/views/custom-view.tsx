import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asDateString, asHourString, asTagValue, asDimensionId } from '@costgoblin/core/browser';
import { shouldAutoSwitchToHourly } from '../lib/drag-select.js';
import { useHourlyConfigured } from '../hooks/use-hourly-configured.js';
import { HourlyHintBanner } from '../components/hourly-hint-banner.js';
import { daysBetween } from '../lib/dates.js';
import type {
  Dimension,
  DimensionId,
  EntityRef,
  FilterMap,
  TagValue,
  ViewSpec,
  AnomalyDetectionParams,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useQuery } from '../hooks/use-query.js';
import { useAnomalies } from '../hooks/use-anomalies.js';
import {
  CostFocusDispatchProvider,
  CostFocusProvider,
  useCostFocusReducer,
} from '../hooks/use-cost-focus.js';
import {
  getDimensionId,
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

function formatHour(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}:00:00`;
}

function previousRangeFor(dr: DateRange): DateRange {
  // Sub-day window (drag-zoom into hours): shift back by the same hour duration
  // so the comparison is apples-to-apples (4 hours vs the prior 4 hours), not
  // 4 hours vs the 1–2 calendar days that contain them.
  if (dr.startHour !== undefined && dr.endHour !== undefined) {
    const startMs = new Date(`${String(dr.startHour).slice(0, 10)}T${String(dr.startHour).slice(11, 19)}Z`).getTime();
    const endMs = new Date(`${String(dr.endHour).slice(0, 10)}T${String(dr.endHour).slice(11, 19)}Z`).getTime();
    const hourMs = 60 * 60 * 1000;
    const durationHours = Math.round((endMs - startMs) / hourMs) + 1;
    const prevEndMs = startMs - hourMs;
    const prevStartMs = prevEndMs - (durationHours - 1) * hourMs;
    const prevStartHour = formatHour(new Date(prevStartMs));
    const prevEndHour = formatHour(new Date(prevEndMs));
    return {
      start: asDateString(prevStartHour.slice(0, 10)),
      end: asDateString(prevEndHour.slice(0, 10)),
      startHour: asHourString(prevStartHour),
      endHour: asHourString(prevEndHour),
    };
  }
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
  const hourlyConfigured = useHourlyConfigured();
  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [filters, setFilters] = useState<FilterMap>(initialFilter ?? {});
  const [hourlyHint, setHourlyHint] = useState(false);
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

  // Anomaly detection: use the first available dimension as groupBy, with a
  // fallback to 'owner'. Detection runs on the current date range and filters,
  // using a 30-day lookback and 2σ threshold (as specified in the spec).
  const anomalyParams: AnomalyDetectionParams = useMemo(() => {
    const firstDim = dimensions[0];
    return {
      dateRange: { start: dateRange.start, end: dateRange.end },
      filters,
      groupBy: firstDim !== undefined ? getDimensionId(firstDim) : asDimensionId('owner'),
      lookbackDays: 30,
      stddevThreshold: 2.0,
    };
  }, [dateRange.start, dateRange.end, filters, dimensions]);

  const anomaliesState = useAnomalies(anomalyParams);
  // Anomaly state will be consumed by widgets in subtask-4-2 (badge integration)
  void anomaliesState;

  // Cancel in-flight DuckDB queries when query-affecting state changes so
  // stale queries don't hog pool connections while new ones queue behind them.
  // Skip until one render AFTER preferences have loaded — the prefs restore
  // itself triggers a state change that we must not cancel.
  const cancelReadyRef = useRef(false);
  const filtersKeyRef = JSON.stringify(filters);
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    if (!cancelReadyRef.current) {
      cancelReadyRef.current = true;
      return;
    }
    api.cancelPendingQueries().catch(() => undefined);
  }, [dateRange, granularity, filtersKeyRef, compareEnabled, api]);

  // Load column preferences on mount. Date range, granularity, and comparison
  // always start at defaults (30d daily, comparison off) for a clean session.
  useEffect(() => {
    api.getExplorerPreferences().then(prefs => {
      columnPrefsRef.current = {
        hiddenColumns: prefs.hiddenColumns,
        columnOrder: prefs.columnOrder,
      };
      prefsLoadedRef.current = true;
    }).catch(() => {
      prefsLoadedRef.current = true;
    });
  }, [api]);

  // Save preferences with debounce — rapid parameter changes (e.g. applying
  // two filters back-to-back) only trigger a single write.
  const savePendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    if (savePendingRef.current !== null) clearTimeout(savePendingRef.current);
    savePendingRef.current = setTimeout(() => {
      api.saveExplorerPreferences({
        hiddenColumns: columnPrefsRef.current.hiddenColumns,
        columnOrder: columnPrefsRef.current.columnOrder,
        lastUsedDateRange: dateRange,
        lastUsedGranularity: granularity,
        compareEnabled,
      }).catch(() => undefined);
    }, 500);
    return () => {
      if (savePendingRef.current !== null) clearTimeout(savePendingRef.current);
    };
  }, [dateRange, granularity, compareEnabled, api]);

  // Pre-fetch filter values for all dimensions so dropdowns open instantly.
  // Cache is keyed by date range — invalidated when the range changes.
  type FilterValue = { value: string; label: string; count: number };
  const filterCacheRef = useRef(new Map<string, FilterValue[]>());
  const filterCacheDateKeyRef = useRef('');

  useEffect(() => {
    if (dimensions.length === 0) return;
    const dateKey = `${dateRange.start}|${dateRange.end}`;
    if (filterCacheDateKeyRef.current !== dateKey) {
      filterCacheRef.current.clear();
      filterCacheDateKeyRef.current = dateKey;
    }
    for (const dim of dimensions) {
      const dimId = getDimensionId(dim);
      if (filterCacheRef.current.has(dimId)) continue;
      api.getFilterValues(dimId, {}, dateRange).then(values => {
        filterCacheRef.current.set(dimId, values);
      }).catch(() => undefined);
    }
  }, [dimensions, dateRange, api]);

  function handleSetFilter(dim: DimensionId, value: TagValue) {
    setFilters(prev => ({ ...prev, [dim]: [value] }));
  }

  const handleDateRangeChange = useCallback((range: DateRange, g?: Granularity) => {
    setDateRange(range);
    if (g !== undefined) {
      setGranularity(g);
      setHourlyHint(false);
      return;
    }
    if (shouldAutoSwitchToHourly(range.start, range.end, granularity)) {
      if (hourlyConfigured) {
        setGranularity('hourly');
        setHourlyHint(false);
      } else {
        setHourlyHint(true);
      }
    } else {
      setHourlyHint(false);
    }
  }, [granularity, hourlyConfigured]);

  useEffect(() => {
    if (!shouldAutoSwitchToHourly(dateRange.start, dateRange.end, granularity)) {
      setHourlyHint(false);
    }
  }, [dateRange.start, dateRange.end, granularity]);

  function handleEntityClick(entity: EntityRef, dim: DimensionId) {
    handleSetFilter(dim, asTagValue(entity));
  }

  function handleGetFilterValues(dimensionId: DimensionId, currentFilters: FilterMap): Promise<FilterValue[]> {
    const hasActiveFilters = Object.keys(currentFilters).some(k => {
      const v = currentFilters[k as DimensionId];
      return v !== undefined && v.length > 0;
    });
    const cached = filterCacheRef.current.get(dimensionId);
    if (!hasActiveFilters && cached !== undefined) {
      return Promise.resolve(cached);
    }
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

      {hourlyHint && (
        <HourlyHintBanner onDismiss={() => { setHourlyHint(false); }} />
      )}

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
                  onDateRangeChange={handleDateRangeChange}
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
