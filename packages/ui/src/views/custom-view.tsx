import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asDateString, asHourString, asTagValue } from '@costgoblin/core/browser';
import { shouldAutoSwitchToHourly } from '../lib/drag-select.js';
import { useHourlyConfigured } from '../hooks/use-hourly-configured.js';
import { HourlyHintBanner } from '../components/hourly-hint-banner.js';
import { UpdatingBadge } from '../components/updating-badge.js';
import { RollupBuildingOverlay } from '../components/rollup-building-overlay.js';
import { daysBetween } from '../lib/dates.js';
import { rollupGate } from '../lib/rollup-gate.js';
import type {
  Dimension,
  DimensionId,
  EntityRef,
  FilterMap,
  RollupStatus,
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
  getDimensionId,
  defaultsFromDimensions,
  isEnvironmentDimension,
  isOwnerDimension,
  isProductDimension,
  isUnitDimension,
} from '../lib/dimensions.js';
import { FilterBar } from '../components/filter-bar.js';
import { FilterActiveBanner } from '../components/filter-active-banner.js';
import { ListMetricBanner } from '../components/list-metric-banner.js';
import {
  DateRangePicker,
  getDefaultDateRange,
} from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';
import { WIDGET_REGISTRY } from '../widgets/registry.js';
import { widgetFlexBasis } from '../widgets/widget.js';
import { LazyWidgetSlot, WidgetSchedulerProvider } from '../hooks/widget-load-scheduler.js';

/** Reserve roughly a widget's eventual height while its slot is deferred, so
 *  the page doesn't jump when it mounts (and charts get a sized container). */
function placeholderMinHeight(type: string): number {
  if (type === 'summary') return 150;
  if (type === 'table') return 360;
  return 300;
}

interface CustomViewProps {
  readonly spec: ViewSpec;
  readonly headerSubtitle?: string | undefined;
  readonly initialFilter?: FilterMap | undefined;
  /** Live rollup state. Drives two things: a blocking build overlay when the
   *  rollup can't serve the viewed period and is building it (cold build or a
   *  cleared rollup), and a non-blocking "Updating…" badge per widget when a
   *  re-roll touches months the user isn't viewing (data stays visible). */
  readonly rollupStatus?: RollupStatus | undefined;
}

function priorityFor(d: Dimension): number {
  if (isEnvironmentDimension(d)) return 0;
  if (isProductDimension(d)) return 1;
  if (isOwnerDimension(d)) return 2;
  if (isUnitDimension(d)) return 3;
  if ('field' in d) return 4;
  return 5;
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

function CustomViewInner({ spec, headerSubtitle, initialFilter, rollupStatus }: CustomViewProps) {
  const api = useCostApi();
  const lagDays = useLagDays();
  const hourlyConfigured = useHourlyConfigured();
  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));

  // Rollup can't serve the viewed months and is building them (cold build or a
  // cleared rollup) → block with the build overlay; widgets don't mount, so
  // they never fire slow raw queries. A re-roll that only touches months the
  // user isn't viewing leaves their data served → not blocked, and the badge
  // below covers it.
  const gate = useMemo(
    () => rollupStatus === undefined
      ? { blocked: false, selectedMonths: [], pendingMonths: [] }
      : rollupGate(rollupStatus, dateRange),
    [rollupStatus, dateRange],
  );
  const reRolling = rollupStatus?.state === 'computing' && !gate.blocked;
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [filters, setFilters] = useState<FilterMap>(initialFilter ?? {});
  // Per-mount latch: seed defaults exactly once after dims load, unless the
  // view received an explicit `initialFilter` (drill-through, saved state).
  // Re-mounting the view (navigation, reload) re-applies defaults — that's
  // the "always re-apply on open" contract.
  const defaultsAppliedRef = useRef(initialFilter !== undefined);
  const [hourlyHint, setHourlyHint] = useState(false);

  const dimensionsQuery = useQuery(() => api.getDimensions(), [api]);
  const rawDimensions: Dimension[] = dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];
  const dimensions = useMemo(
    () => [...rawDimensions].sort((a, b) => priorityFor(a) - priorityFor(b)),
    [rawDimensions],
  );

  useEffect(() => {
    if (defaultsAppliedRef.current) return;
    if (dimensionsQuery.status !== 'success') return;
    const defaults = defaultsFromDimensions(dimensionsQuery.data);
    defaultsAppliedRef.current = true;
    if (Object.keys(defaults).length > 0) setFilters(defaults);
  }, [dimensionsQuery]);

  const previousDateRange = useMemo(
    () => previousRangeFor(dateRange),
    [dateRange],
  );

  // Cancel in-flight DuckDB queries when query-affecting state changes so
  // stale queries don't hog pool connections while new ones queue behind them.
  // Skip the mount run — the initial render isn't a change to cancel.
  const cancelReadyRef = useRef(false);
  const filtersKeyRef = JSON.stringify(filters);
  useEffect(() => {
    if (!cancelReadyRef.current) {
      cancelReadyRef.current = true;
      return;
    }
    api.cancelPendingQueries().catch(() => undefined);
  }, [dateRange, granularity, filtersKeyRef, compareEnabled, api]);

  // Save preferences with debounce — rapid parameter changes (e.g. applying
  // two filters back-to-back) only trigger a single write. This view doesn't
  // manage column visibility, so it omits hiddenColumns/columnOrder entirely —
  // the save merges onto the on-disk prefs, leaving the user's curated column
  // set (owned by the Explorer) untouched.
  //
  // The gate is a plain mount-skip: this view restores nothing from prefs
  // (date range, granularity and comparison always start at defaults for a
  // clean session), so the only thing to suppress is the save that the mount
  // render would otherwise fire, writing those defaults over the shared file.
  // Gating on an async prefs read instead would drop any change the user made
  // while that read was still in flight — a ref flip doesn't re-run the effect.
  const saveReadyRef = useRef(false);
  const savePendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!saveReadyRef.current) {
      saveReadyRef.current = true;
      return;
    }
    if (savePendingRef.current !== null) clearTimeout(savePendingRef.current);
    savePendingRef.current = setTimeout(() => {
      savePendingRef.current = null;
      api.saveExplorerPreferences({
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
      api.getFilterValues(dimId, {}, dateRange, undefined, `filter-bar:prefetch:${dimId}`).then(values => {
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
    return api.getFilterValues(dimensionId, plain, dateRange, undefined, `filter-bar:${dimensionId}`);
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
          defaults={defaultsFromDimensions(dimensions)}
        />
      )}

      <ListMetricBanner />

      <FilterActiveBanner />

      {hourlyHint && (
        <HourlyHintBanner onDismiss={() => { setHourlyHint(false); }} />
      )}

      {dimensionsQuery.status === 'loading' && !gate.blocked && (
        <div className="text-sm text-text-secondary">Loading...</div>
      )}

      {gate.blocked && rollupStatus !== undefined ? (
        <RollupBuildingOverlay status={rollupStatus} pendingMonths={gate.pendingMonths} />
      ) : (
      <WidgetSchedulerProvider>
        {spec.rows.map((row, rowIdx) => {
          // Flat display order across rows = load priority (top-left first).
          const offset = spec.rows.slice(0, rowIdx).reduce((n, r) => n + r.widgets.length, 0);
          return (
            <div key={row.widgets.map(w => w.id).join('-')} className="flex gap-4 items-stretch min-w-0">
              {row.widgets.map((w, colIdx) => {
                const Renderer = WIDGET_REGISTRY[w.type];
                return (
                  <LazyWidgetSlot
                    key={w.id}
                    id={w.id}
                    priority={offset + colIdx}
                    minHeight={placeholderMinHeight(w.type)}
                    className="relative min-w-0 flex flex-col"
                    style={{ flexBasis: widgetFlexBasis(w.size), flexGrow: 1, flexShrink: 1 }}
                  >
                    {reRolling && <UpdatingBadge />}
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
                  </LazyWidgetSlot>
                );
              })}
            </div>
          );
        })}
      </WidgetSchedulerProvider>
      )}
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
