import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CostMetric,
  DateRange,
  Dimension,
  ExplorerFilterMap,
  ExplorerFilterValue,
  ExplorerOverviewResult,
  ExplorerRowsResult,
  ExplorerSampleRow,
  ExplorerSort,
  Granularity,
} from '@costgoblin/core/browser';
import { DEFAULT_EXPLORER_HIDDEN_COLUMNS, asDateString, asHourString } from '@costgoblin/core/browser';
import type { SortingState } from '@tanstack/react-table';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useBarDragSelect } from '../hooks/use-bar-drag-select.js';
import { useHourlyConfigured } from '../hooks/use-hourly-configured.js';
import { formatDollars } from '../components/format.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { DataTable } from '../components/data-table.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { HourlyHintBanner } from '../components/hourly-hint-banner.js';
import { getDimensionId } from '../lib/dimensions.js';
import { bucketKeyToDate, formatBucketKey, normalizeHourKey, shouldAutoSwitchToHourly } from '../lib/drag-select.js';
import type { TableColumn } from '../lib/table-types.js';

const DEBOUNCE_MS = 250;
const ROW_LIMIT = 500;

function formatSignedDollars(n: number): string {
  if (n < 0) return `-${formatDollars(-n)}`;
  return formatDollars(n);
}

interface OverviewState {
  data: ExplorerOverviewResult | null;
  loading: boolean;
  error: string | null;
}

interface RowsState {
  data: ExplorerRowsResult | null;
  loading: boolean;
  error: string | null;
}

function hourDisplay(hour: string): string {
  if (hour.length === 0) return '';
  const time = hour.includes(' ') ? hour.split(' ')[1] ?? hour : hour;
  return time.slice(0, 8);
}

const BASE_COLUMNS: readonly TableColumn<ExplorerSampleRow>[] = [
  { id: 'usage_date', header: 'Date', accessorFn: r => r.date, mono: true },
  { id: 'charge_category', header: 'Charge Category', dimId: 'charge_category', clickable: true, accessorFn: r => r.chargeCategory },
  {
    id: 'cost', header: 'Cost', align: 'right', mono: true,
    accessorFn: r => r.cost,
    cell: (v) => {
      const n = v as number;
      const cls = n < 0 ? 'text-warning' : '';
      return <span className={cls}>{formatSignedDollars(n)}</span>;
    },
  },
  { id: 'service_category', header: 'Service Category', dimId: 'service_category', clickable: true, accessorFn: r => r.serviceCategory },
  { id: 'region', header: 'Region', dimId: 'region', clickable: true, accessorFn: r => r.region, mono: true },
  { id: 'account_name', header: 'Account', dimId: 'account', clickable: true, accessorFn: r => r.accountName.length > 0 ? r.accountName : r.accountId },
  { id: 'resource_id', header: 'Resource', dimId: 'resource_id', clickable: true, accessorFn: r => r.resourceId, mono: true, truncate: true },
  { id: 'description', header: 'Description', accessorFn: r => r.description, truncate: true },
  { id: 'sku_meter', header: 'SKU Meter', dimId: 'sku_meter', clickable: true, accessorFn: r => r.skuMeter, mono: true },
  { id: 'usage_hour', header: 'Hour', accessorFn: r => hourDisplay(r.hour), mono: true },
  {
    id: 'list_cost', header: 'List', align: 'right', mono: true,
    accessorFn: r => r.listCost,
    cell: (v) => formatSignedDollars(v as number),
  },
  { id: 'service', header: 'Service', dimId: 'service', clickable: true, accessorFn: r => r.service },
  {
    id: 'usage_amount', header: 'Usage', align: 'right', mono: true,
    accessorFn: r => r.usageAmount,
    cell: (v) => {
      const n = v as number;
      return n === 0 ? '' : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    },
  },
  { id: 'operation', header: 'Operation', dimId: 'operation', clickable: true, accessorFn: r => r.operation },
];

export function ExplorerView(): React.JSX.Element {
  const api = useCostApi();
  const lagDays = useLagDays();
  const hourlyConfigured = useHourlyConfigured();
  const [filters, setFilters] = useState<ExplorerFilterMap>({});
  const [sort, setSort] = useState<ExplorerSort | undefined>(undefined);
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [applyCostScope, setApplyCostScope] = useState(false);
  const [costMetric, setCostMetric] = useState<CostMetric>('effective');
  const [overview, setOverview] = useState<OverviewState>({ data: null, loading: true, error: null });
  const [rows, setRows] = useState<RowsState>({ data: null, loading: true, error: null });
  const [hiddenColumns, setHiddenColumns] = useState<readonly string[]>([...DEFAULT_EXPLORER_HIDDEN_COLUMNS]);
  const [columnOrder, setColumnOrder] = useState<readonly string[]>([]);
  const [hourlyHint, setHourlyHint] = useState(false);
  const overviewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overviewReqIdRef = useRef(0);
  const rowsReqIdRef = useRef(0);
  const prefsLoadedRef = useRef(false);

  useEffect(() => {
    // Store ALL dims (not just enabled). The filter bar normally hides
    // disabled dims, but it needs to fall back to the full list to render
    // chips for dims with active filters — e.g. the user clicks a Resource
    // cell and that dim is disabled-by-default high-cardinality.
    api.getDimensions().then(dims => {
      setDimensions(dims);
      // Seed defaults exactly once per mount. The Explorer's filter state is
      // in-memory only, so on next mount the dim defaults re-apply — same
      // contract as CustomView.
      const defaults: Record<string, readonly string[]> = {};
      for (const d of dims) {
        const vals = d.defaultFilterValues;
        if (vals === undefined || vals.length === 0) continue;
        defaults[getDimensionId(d)] = [...vals];
      }
      if (Object.keys(defaults).length > 0) setFilters(defaults);
    }).catch(() => { setDimensions([]); });
    api.getExplorerPreferences().then(prefs => {
      setHiddenColumns(prefs.hiddenColumns);
      setColumnOrder(prefs.columnOrder);
      if (prefs.lastUsedDateRange !== undefined) {
        setDateRange(prefs.lastUsedDateRange);
      }
      if (prefs.lastUsedGranularity !== undefined) {
        setGranularity(prefs.lastUsedGranularity);
      }
      prefsLoadedRef.current = true;
    }).catch(() => {
      // Keep the DEFAULT_EXPLORER_HIDDEN_COLUMNS initial state — a failed
      // prefs load must not reveal every column.
      prefsLoadedRef.current = true;
    });
  }, [api]);

  // Persist preferences on change. Fire-and-forget — the UI already
  // reflects the new state locally, so a write failure just means the
  // preference won't survive a reload (rare edge case, not worth surfacing).
  // Saves are merged onto the on-disk prefs, so each of these sends ONLY the
  // fields it is actually changing.
  function saveSessionPrefs(range: DateRange, gran: Granularity) {
    api.saveExplorerPreferences({
      lastUsedDateRange: range,
      lastUsedGranularity: gran,
    }).catch(() => undefined);
  }

  // Column writes carry only the column fields — and only ever run from a
  // deliberate user action in the column picker. Crucially they are NOT sent
  // on the date-range path below: on a failed prefs load this component's
  // column state is still the DEFAULT seed, and echoing that back would
  // overwrite the user's real on-disk set with the defaults.
  function updateHiddenColumns(next: readonly string[]) {
    setHiddenColumns(next);
    api.saveExplorerPreferences({ hiddenColumns: next }).catch(() => undefined);
  }

  function updateColumnOrder(next: readonly string[]) {
    setColumnOrder(next);
    api.saveExplorerPreferences({ columnOrder: next }).catch(() => undefined);
  }

  // Save date range / granularity whenever they change. Skip saves until
  // after preferences have loaded — the prefsLoadedRef flag is set in the
  // mount effect once the initial load completes (or fails). This prevents
  // redundant writes when restoring persisted values on mount.
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    saveSessionPrefs(dateRange, granularity);
  }, [dateRange, granularity]);

  const cancelReadyRef = useRef(false);
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    if (!cancelReadyRef.current) {
      cancelReadyRef.current = true;
      return;
    }
    api.cancelPendingQueries().catch(() => undefined);
  }, [dateRange, granularity, api]);

  const runOverview = useCallback((
    f: ExplorerFilterMap,
    range: DateRange,
    gran: Granularity,
    scope: boolean,
    metric: CostMetric,
  ) => {
    const reqId = ++overviewReqIdRef.current;
    setOverview(prev => ({ ...prev, loading: true, error: null }));
    api.queryExplorerOverview({
      filters: f,
      dateRange: range,
      granularity: gran,
      applyCostScope: scope,
      costMetric: metric,
      origin: 'explorer:overview',
    })
      .then(data => {
        if (reqId !== overviewReqIdRef.current) return;
        // Transition: keep the histogram render interruptible so input isn't
        // starved while it commits (see use-query.ts for the rationale).
        startTransition(() => { setOverview({ data, loading: false, error: null }); });
      })
      .catch((err: unknown) => {
        if (reqId !== overviewReqIdRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setOverview(prev => ({ data: prev.data, loading: false, error: message }));
      });
  }, [api]);

  const runRows = useCallback((
    f: ExplorerFilterMap,
    s: ExplorerSort | undefined,
    range: DateRange,
    gran: Granularity,
    scope: boolean,
    metric: CostMetric,
  ) => {
    const reqId = ++rowsReqIdRef.current;
    setRows(prev => ({ ...prev, loading: true, error: null }));
    api.queryExplorerRows({
      filters: f,
      rowLimit: ROW_LIMIT,
      dateRange: range,
      granularity: gran,
      applyCostScope: scope,
      costMetric: metric,
      ...(s === undefined ? {} : { sort: s }),
      origin: 'explorer:rows',
    })
      .then(data => {
        if (reqId !== rowsReqIdRef.current) return;
        // Transition: the rows table can be large; keep its render interruptible
        // so the UI stays responsive while it commits.
        startTransition(() => { setRows({ data, loading: false, error: null }); });
      })
      .catch((err: unknown) => {
        if (reqId !== rowsReqIdRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setRows(prev => ({ data: prev.data, loading: false, error: message }));
      });
  }, [api]);

  // Overview (histogram + totals) — deliberately omits `sort` from deps so
  // changing the table sort doesn't wipe the histogram.
  useEffect(() => {
    if (overviewDebounceRef.current !== null) clearTimeout(overviewDebounceRef.current);
    overviewDebounceRef.current = setTimeout(() => {
      runOverview(filters, dateRange, granularity, applyCostScope, costMetric);
    }, DEBOUNCE_MS);
    return () => {
      if (overviewDebounceRef.current !== null) clearTimeout(overviewDebounceRef.current);
    };
  }, [filters, dateRange, granularity, applyCostScope, costMetric, runOverview]);

  // Sample rows — all overview deps PLUS sort. A sort-only change therefore
  // only re-fires this fetch, leaving the histogram alone.
  useEffect(() => {
    if (rowsDebounceRef.current !== null) clearTimeout(rowsDebounceRef.current);
    rowsDebounceRef.current = setTimeout(() => {
      runRows(filters, sort, dateRange, granularity, applyCostScope, costMetric);
    }, DEBOUNCE_MS);
    return () => {
      if (rowsDebounceRef.current !== null) clearTimeout(rowsDebounceRef.current);
    };
  }, [filters, sort, dateRange, granularity, applyCostScope, costMetric, runRows]);

  const tagColumns = overview.data?.tagColumns ?? rows.data?.tagColumns ?? [];
  const defaultColumns = useMemo<readonly TableColumn<ExplorerSampleRow>[]>(() => [
    ...BASE_COLUMNS.filter(c => c.id !== 'usage_hour' || granularity === 'hourly'),
    ...tagColumns.map<TableColumn<ExplorerSampleRow>>(t => ({
      id: t.id,
      header: t.label,
      dimId: t.id,
      clickable: true,
      accessorFn: (r: ExplorerSampleRow) => r.tags[t.id] ?? '',
    })),
  ], [tagColumns, granularity]);

  const availableColumns = useMemo<readonly TableColumn<ExplorerSampleRow>[]>(() => {
    if (columnOrder.length === 0) return defaultColumns;
    const byKey = new Map(defaultColumns.map(c => [c.id, c]));
    const seen = new Set<string>();
    const ordered: TableColumn<ExplorerSampleRow>[] = [];
    for (const key of columnOrder) {
      const col = byKey.get(key);
      if (col !== undefined && !seen.has(key)) {
        ordered.push(col);
        seen.add(key);
      }
    }
    for (const col of defaultColumns) {
      if (!seen.has(col.id)) ordered.push(col);
    }
    return ordered;
  }, [defaultColumns, columnOrder]);

  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);

  // Columns auto-hidden because the user has pinned their dim to a single
  // filter value — every cell would show that same value, so the column
  // carries no information. Cleared automatically when the filter is
  // widened. Kept separate from `hiddenColumns` so the user's explicit
  // preference isn't overwritten.
  const autoHiddenSet = useMemo(() => {
    const keys = new Set<string>();
    for (const [dimId, values] of Object.entries(filters)) {
      if (values.length !== 1) continue;
      for (const col of availableColumns) {
        if (col.dimId === dimId) keys.add(col.id);
      }
    }
    return keys;
  }, [filters, availableColumns]);

  const visibleColumns = useMemo(
    () => availableColumns.filter(c => !hiddenSet.has(c.id) && !autoHiddenSet.has(c.id)),
    [availableColumns, hiddenSet, autoHiddenSet],
  );

  function addFilterValue(dimId: string, value: string) {
    setFilters(prev => {
      const existing = prev[dimId] ?? [];
      if (existing.includes(value)) return prev;
      return { ...prev, [dimId]: [...existing, value] };
    });
  }

  function setFilterValues(dimId: string, values: readonly string[]) {
    setFilters(prev => {
      if (values.length === 0) {
        return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== dimId));
      }
      return { ...prev, [dimId]: values };
    });
  }

  function clearAll() {
    setFilters({});
  }

  const tanstackSorting = useMemo<SortingState>(() => {
    if (sort === undefined) return [];
    return [{ id: sort.column, desc: sort.direction === 'desc' }];
  }, [sort]);

  function handleSortingChange(state: SortingState) {
    if (state.length === 0) {
      setSort(undefined);
    } else {
      const first = state[0];
      if (first !== undefined) {
        setSort({ column: first.id, direction: first.desc ? 'desc' : 'asc' });
      }
    }
  }

  function handleCellClick(_row: ExplorerSampleRow, columnId: string, value: unknown) {
    const col = availableColumns.find(c => c.id === columnId);
    const dimId = col?.dimId;
    if (dimId !== undefined && dimId !== null && typeof value === 'string' && value.length > 0) {
      addFilterValue(dimId, value);
    }
  }

  const activeFilterCount = Object.values(filters).reduce((n, vs) => n + vs.length, 0);
  const overviewData = overview.data;
  const dailyTotals = useMemo(() => overviewData?.dailyTotals ?? [], [overviewData]);

  const handleHistogramRangeSelect = useCallback((startIdx: number, endIdx: number) => {
    const startBar = dailyTotals[startIdx];
    const endBar = dailyTotals[endIdx];
    if (startBar === undefined || endBar === undefined) return;
    if (granularity === 'hourly') {
      // Each bar is one hour bucket — keep the hour info so the rest of
      // the Explorer (overview totals, table) filters on the same window.
      const startHour = normalizeHourKey(startBar.date);
      const endHour = normalizeHourKey(endBar.date);
      if (startHour === null || endHour === null) return;
      setDateRange({
        start: asDateString(startHour.slice(0, 10)),
        end: asDateString(endHour.slice(0, 10)),
        startHour: asHourString(startHour),
        endHour: asHourString(endHour),
      });
      setHourlyHint(false);
      return;
    }
    const startDate = bucketKeyToDate(startBar.date);
    const endDate = bucketKeyToDate(endBar.date);
    setDateRange({ start: asDateString(startDate), end: asDateString(endDate) });
    if (shouldAutoSwitchToHourly(startDate, endDate, granularity)) {
      if (hourlyConfigured) {
        setGranularity('hourly');
        setHourlyHint(false);
      } else {
        setHourlyHint(true);
      }
    } else {
      setHourlyHint(false);
    }
  }, [dailyTotals, granularity, hourlyConfigured]);

  useEffect(() => {
    if (!shouldAutoSwitchToHourly(dateRange.start, dateRange.end, granularity)) {
      setHourlyHint(false);
    }
  }, [dateRange.start, dateRange.end, granularity]);

  return (
    <div className="p-6 max-w-[1800px] mx-auto space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-medium text-text-secondary">Inspect the raw billing dataset.</p>
          {overviewData !== null && (
            <div className="mt-1 text-xs text-text-muted tabular-nums">
              {formatDollars(overviewData.totalCost)} · {overviewData.totalRows.toLocaleString()} line items
              {' · '}
              {overviewData.startDate} → {overviewData.endDate}
            </div>
          )}
        </div>
        <DateRangePicker
          value={dateRange}
          granularity={granularity}
          onChange={(range, g) => { setDateRange(range); setGranularity(g); }}
          lagDays={lagDays}
        />
      </div>

      <ExplorerOptions
        applyCostScope={applyCostScope}
        onApplyCostScopeChange={setApplyCostScope}
        costMetric={costMetric}
        onCostMetricChange={setCostMetric}
      />

      <div className="flex items-center justify-between">
        <MultiFilterBar
          dimensions={dimensions}
          filters={filters}
          onChange={setFilterValues}
          fetchValues={(dimId) => api.getExplorerFilterValues({
            dimensionId: dimId,
            filters,
            dateRange,
            granularity,
            applyCostScope,
            costMetric,
            origin: `explorer:filter-values:${dimId}`,
          })}
        />
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="shrink-0 text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
          >
            Clear all ({String(activeFilterCount)})
          </button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{granularity === 'hourly' ? 'Hourly total' : 'Daily total'}</CardTitle>
        </CardHeader>
        <CardContent>
          <Histogram
            days={dailyTotals}
            loading={overview.loading}
            onRangeSelect={handleHistogramRangeSelect}
          />
          {hourlyHint && (
            <HourlyHintBanner className="mt-3" onDismiss={() => { setHourlyHint(false); }} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <DataTable<ExplorerSampleRow>
            data={rows.data?.sampleRows ?? []}
            columns={visibleColumns}
            allColumns={availableColumns}
            hiddenColumns={hiddenColumns}
            autoHiddenKeys={autoHiddenSet}
            onHiddenColumnsChange={updateHiddenColumns}
            onColumnOrderChange={updateColumnOrder}
            sorting={tanstackSorting}
            onSortingChange={handleSortingChange}
            onCellClick={handleCellClick}
            totalRows={overviewData?.totalRows ?? 0}
            loading={rows.loading}
            error={rows.error}
            height={560}
            rowHeight={28}
            csvFilename={`costgoblin-explorer-${dateRange.start}-${dateRange.end}`}
            renderExpandedRow={(row) => <RowDetail row={row} allColumns={availableColumns} />}
          />
        </CardContent>
      </Card>
    </div>
  );
}

interface ExplorerOptionsProps {
  readonly applyCostScope: boolean;
  readonly onApplyCostScopeChange: (v: boolean) => void;
  readonly costMetric: CostMetric;
  readonly onCostMetricChange: (m: CostMetric) => void;
}

function ExplorerOptions({
  applyCostScope,
  onApplyCostScopeChange,
  costMetric,
  onCostMetricChange,
}: ExplorerOptionsProps): React.JSX.Element {
  const metricOptions: { value: CostMetric; label: string; title: string }[] = [
    { value: 'effective', label: 'Effective (amortized)', title: 'Amortized cost including unused commitment — matches Cost Explorer amortized. The attribution default.' },
    { value: 'billed', label: 'Billed', title: 'The invoiced amount. Commitment purchases land as Purchase rows; covered usage shows $0.' },
    { value: 'list', label: 'List price', title: 'Hypothetical on-demand list price (Usage rows only).' },
    { value: 'contracted', label: 'Contracted', title: 'After negotiated discounts, before commitment discounts.' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
        <input
          type="checkbox"
          className="accent-accent"
          checked={applyCostScope}
          onChange={e => { onApplyCostScopeChange(e.target.checked); }}
        />
        <span className="text-text-secondary">Apply Cost Scope</span>
        <span className="text-text-muted">(hide Tax, Credits, RI purchases, etc.)</span>
      </label>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-text-muted">Metric:</span>
        <div className="flex items-center gap-3">
          {metricOptions.map(opt => (
            <label
              key={opt.value}
              className="flex items-center gap-1 select-none cursor-pointer"
              title={opt.title}
            >
              <input
                type="radio"
                name="explorer-metric"
                className="accent-accent"
                checked={costMetric === opt.value}
                onChange={() => { onCostMetricChange(opt.value); }}
              />
              <span className="text-text-secondary">{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

interface HistogramProps {
  readonly days: readonly { readonly date: string; readonly cost: number; readonly rows: number }[];
  readonly loading: boolean;
  readonly onRangeSelect?: (startIdx: number, endIdx: number) => void;
}

const CHART_HEIGHT = 200;
const Y_AXIS_WIDTH = 48;
const Y_TICKS = [1, 0.75, 0.5, 0.25, 0] as const;

/** Time-series histogram for the Explorer. Matches the visual style of the
 *  main dashboard's StackedBarChart (Y-axis ticks, grid, hover tooltip)
 *  but single-series — Explorer doesn't split the total, it's raw counts
 *  over time. Bucket width follows whatever the handler emits (day or
 *  hour), so the same component handles daily and hourly granularities. */
function Histogram({ days, loading, onRangeSelect }: HistogramProps): React.JSX.Element {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const { isDragging, overlay, selection, handleMouseDown } = useBarDragSelect({
    containerRef: barsRef,
    bucketCount: days.length,
    onRangeSelect,
    disabled: onRangeSelect === undefined || loading,
  });

  const dragLabels = (() => {
    if (selection === null) return null;
    const startBar = days[selection.startIdx];
    const endBar = days[selection.endIdx];
    if (startBar === undefined || endBar === undefined) return null;
    return { start: formatBucketKey(startBar.date), end: formatBucketKey(endBar.date) };
  })();

  if (loading) {
    return <CoinRainLoader height={CHART_HEIGHT} count={6} />;
  }
  const max = days.reduce((m, d) => Math.max(m, d.cost), 0);
  if (days.length === 0 || max <= 0) {
    return (
      <div className="flex items-center justify-center text-xs text-text-muted" style={{ height: CHART_HEIGHT }}>
        No data in the selected range.
      </div>
    );
  }

  // Smart x-axis labels — show ~7 evenly spaced ticks, never more. For
  // hourly views with 168+ bars this keeps the axis readable.
  const labelStep = Math.max(1, Math.ceil(days.length / 7));

  return (
    <div className="space-y-1">
      <div className="relative" style={{ height: CHART_HEIGHT }}>
        {/* Y-axis tick labels */}
        <div className="absolute left-0 top-0 h-full" style={{ width: Y_AXIS_WIDTH }}>
          {Y_TICKS.map(pct => (
            <div
              key={pct}
              className="absolute right-2 flex items-center"
              style={{ top: `${String((1 - pct) * 100)}%`, transform: 'translateY(-50%)' }}
            >
              <span className="text-[10px] text-text-muted tabular-nums">{formatDollars(max * pct)}</span>
            </div>
          ))}
        </div>

        {/* Grid lines */}
        <div className="absolute top-0 right-0 h-full" style={{ left: Y_AXIS_WIDTH }}>
          {Y_TICKS.map(pct => (
            <div
              key={pct}
              className="absolute left-0 right-0 border-b border-border-subtle/50"
              style={{ top: `${String((1 - pct) * 100)}%` }}
            />
          ))}
        </div>

        {/* Bars */}
        <div
          ref={barsRef}
          role={onRangeSelect === undefined ? undefined : 'button'}
          tabIndex={onRangeSelect === undefined ? undefined : 0}
          className={[
            'absolute top-0 right-0 h-full flex items-end outline-none',
            onRangeSelect === undefined ? '' : 'cursor-crosshair select-none',
          ].join(' ')}
          style={{ left: Y_AXIS_WIDTH, gap: 2 }}
          onMouseDown={handleMouseDown}
        >
          {days.map(d => {
            const pct = (d.cost / max) * 100;
            const isHovered = hoveredKey === d.date;
            return (
              <div
                key={d.date}
                role="img"
                aria-label={`${d.date}: ${formatDollars(d.cost)}`}
                className="group relative flex-1 min-w-0 flex flex-col justify-end"
                style={{ height: '100%' }}
                onMouseEnter={() => { setHoveredKey(d.date); }}
                onMouseLeave={() => { setHoveredKey(null); }}
              >
                <div
                  className={[
                    'w-full rounded-t-sm transition-colors',
                    isHovered && !isDragging ? 'bg-accent' : 'bg-accent/80',
                  ].join(' ')}
                  style={{ height: `${String(Math.max(pct, 0.5))}%` }}
                />
                {isHovered && !isDragging && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20">
                    <div className="rounded-lg border border-border bg-bg-secondary/95 px-3 py-2 text-[11px] text-text-primary whitespace-nowrap shadow-lg min-w-[160px]">
                      <div className="font-semibold mb-1.5 text-xs">{d.date}</div>
                      <div className="flex items-center justify-between gap-3 mb-0.5">
                        <span className="text-text-secondary">Cost</span>
                        <span className="tabular-nums font-medium">{formatDollars(d.cost)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-text-secondary">Rows</span>
                        <span className="tabular-nums text-text-secondary">{d.rows.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {overlay !== null && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 bg-accent/20 border-l border-r border-accent z-30"
              style={{ left: overlay.left, width: overlay.width }}
            />
          )}
          {overlay !== null && dragLabels !== null && (
            <>
              <div
                className="pointer-events-none absolute -top-5 z-40 -translate-x-1/2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-bg-primary shadow whitespace-nowrap tabular-nums"
                style={{ left: overlay.left }}
              >
                {dragLabels.start}
              </div>
              <div
                className="pointer-events-none absolute -top-5 z-40 -translate-x-1/2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-bg-primary shadow whitespace-nowrap tabular-nums"
                style={{ left: overlay.left + overlay.width }}
              >
                {dragLabels.end}
              </div>
            </>
          )}
        </div>
      </div>

      {/* X-axis labels — positioned absolutely so they don't get clipped
          by the flex-1 containers when there are hundreds of bars */}
      <div className="relative h-4" style={{ marginLeft: Y_AXIS_WIDTH }}>
        {days.map((d, idx) => {
          if (idx % labelStep !== 0) return null;
          const pct = days.length > 1 ? (idx / (days.length - 1)) * 100 : 0;
          const isFirst = idx === 0;
          const isLast = idx >= days.length - labelStep;
          let align = '-translate-x-1/2';
          if (isFirst) align = '';
          else if (isLast) align = '-translate-x-full';
          return (
            <span
              key={d.date}
              className={`absolute text-[10px] text-text-muted whitespace-nowrap ${align}`}
              style={{ left: `${String(pct)}%` }}
            >
              {formatBucketLabel(d.date)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Compact axis label: "MM-DD" for daily buckets, "MM-DD HH:00" for
 *  hourly. Inputs are the raw VARCHAR-casted timestamps from DuckDB. */
function formatBucketLabel(bucket: string): string {
  // Daily rows arrive as "YYYY-MM-DD"; hourly as "YYYY-MM-DD HH:MM:SS".
  if (bucket.length === 10) return bucket.slice(5); // MM-DD
  const parts = bucket.split(' ');
  const datePart = parts[0] ?? bucket;
  const timePart = parts[1] ?? '';
  const hour = timePart.slice(0, 5); // HH:MM
  return `${datePart.slice(5)} ${hour}`;
}

interface MultiFilterBarProps {
  readonly dimensions: readonly Dimension[];
  readonly filters: ExplorerFilterMap;
  readonly onChange: (dimId: string, values: readonly string[]) => void;
  readonly fetchValues: (dimId: string) => Promise<readonly ExplorerFilterValue[]>;
}

type DropdownState =
  | { status: 'closed' }
  | { status: 'loading'; dimId: string }
  | { status: 'ready'; dimId: string; values: readonly ExplorerFilterValue[] }
  | { status: 'error'; dimId: string; message: string };

function MultiFilterBar({ dimensions, filters, onChange, fetchValues }: MultiFilterBarProps): React.JSX.Element {
  const [dropdown, setDropdown] = useState<DropdownState>({ status: 'closed' });
  const containerRef = useRef<HTMLDivElement>(null);

  // Show every enabled dim PLUS any disabled dim that currently carries
  // an active filter — so a user who clicked a cell for a disabled dim
  // (resource_id is high-cardinality and default-off) can still see /
  // edit / remove that filter rather than being stuck with "Clear all".
  const visibleDims = useMemo(() => {
    return dimensions.filter(d => {
      const dimId = getDimensionId(d);
      if (d.enabled !== false) return true;
      const active = filters[dimId];
      return active !== undefined && active.length > 0;
    });
  }, [dimensions, filters]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current !== null && !containerRef.current.contains(e.target as Node)) {
        setDropdown({ status: 'closed' });
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => { document.removeEventListener('mousedown', handleClickOutside); };
  }, []);

  function openDim(dimId: string) {
    if (dropdown.status !== 'closed' && 'dimId' in dropdown && dropdown.dimId === dimId) {
      setDropdown({ status: 'closed' });
      return;
    }
    setDropdown({ status: 'loading', dimId });
    fetchValues(dimId).then(
      values => {
        setDropdown(prev => {
          // Drop stale responses — the user may have opened a different dim
          // while this query was in flight.
          if (prev.status === 'closed') return prev;
          if (!('dimId' in prev) || prev.dimId !== dimId) return prev;
          return { status: 'ready', dimId, values };
        });
      },
      (err: unknown) => {
        setDropdown(prev => {
          if (prev.status === 'closed') return prev;
          if (!('dimId' in prev) || prev.dimId !== dimId) return prev;
          return { status: 'error', dimId, message: err instanceof Error ? err.message : String(err) };
        });
      },
    );
  }

  return (
    <div ref={containerRef} className="flex flex-wrap items-center gap-2">
      {visibleDims.map(dim => {
        const dimId = getDimensionId(dim);
        const active = filters[dimId] ?? [];
        const isOpen = dropdown.status !== 'closed' && 'dimId' in dropdown && dropdown.dimId === dimId;
        const chipLabel = (() => {
          if (active.length === 0) return dim.label;
          if (active.length === 1) return `${dim.label}: ${active[0] ?? ''}`;
          return `${dim.label} · ${String(active.length)}`;
        })();
        return (
          <div key={dimId} className="relative">
            <button
              type="button"
              onClick={() => { openDim(dimId); }}
              className={[
                'flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active.length === 0
                  ? 'border-border bg-bg-tertiary/30 text-text-secondary hover:border-border hover:text-text-primary'
                  : 'border-accent bg-accent-muted text-accent',
              ].join(' ')}
            >
              {chipLabel}
            </button>
            {isOpen && (
              <ValuesPicker
                dropdown={dropdown}
                selected={active}
                onApply={(next) => { onChange(dimId, next); }}
                onClose={() => { setDropdown({ status: 'closed' }); }}
              />
            )}
          </div>
        );
      })}
      {visibleDims.length === 0 && (
        <span className="text-xs text-text-muted">No dimensions configured.</span>
      )}
    </div>
  );
}

interface ValuesPickerProps {
  readonly dropdown: DropdownState;
  readonly selected: readonly string[];
  readonly onApply: (next: readonly string[]) => void;
  readonly onClose: () => void;
}

function ValuesPicker({ dropdown, selected, onApply, onClose }: ValuesPickerProps): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState(selected);

  // Reset the draft when the dim changes — otherwise re-opening a
  // previously-selected dim would show stale draft state.
  useEffect(() => {
    setDraft(selected);
    setSearch('');
  }, [selected]);

  function toggle(value: string) {
    setDraft(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  }

  function apply() {
    onApply(draft);
    onClose();
  }

  function clear() {
    setDraft([]);
  }

  const filteredValues = dropdown.status === 'ready'
    ? dropdown.values.filter(v => search.length === 0 || v.label.toLowerCase().includes(search.toLowerCase()))
    : [];

  return (
    <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-bg-secondary shadow-lg">
      <div className="border-b border-border p-2">
        <input
          autoFocus
          type="text"
          value={search}
          placeholder="Search values…"
          onChange={(e) => { setSearch(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter') apply();
          }}
          className="w-full rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {dropdown.status === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-muted">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
            <span>Loading…</span>
          </div>
        )}
        {dropdown.status === 'error' && (
          <div className="px-3 py-4 text-xs text-negative">Failed to load: {dropdown.message}</div>
        )}
        {dropdown.status === 'ready' && filteredValues.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-muted">No matching values.</div>
        )}
        {dropdown.status === 'ready' && filteredValues.map(v => {
          const checked = draft.includes(v.value);
          return (
            <label
              key={v.value}
              className={[
                'flex items-center justify-between gap-2 px-3 py-1.5 text-xs cursor-pointer select-none',
                checked ? 'bg-accent-muted/50 text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary',
              ].join(' ')}
            >
              <span className="flex items-center gap-2 min-w-0 flex-1">
                <input
                  type="checkbox"
                  className="accent-accent shrink-0"
                  checked={checked}
                  onChange={() => { toggle(v.value); }}
                />
                <span className="truncate">{v.label}</span>
              </span>
              <span className="shrink-0 text-text-muted tabular-nums">{formatDollars(v.cost)}</span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-border p-2 gap-2">
        <button
          type="button"
          onClick={clear}
          className="text-xs text-text-secondary hover:text-text-primary"
          disabled={draft.length === 0}
        >
          Clear
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg-primary hover:bg-accent/90"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}


const DETAIL_FIELDS: readonly { key: string; label: string; render: (r: import('@costgoblin/core/browser').ExplorerSampleRow) => string }[] = [
  { key: 'date', label: 'Date', render: r => r.date },
  { key: 'hour', label: 'Hour', render: r => r.hour },
  { key: 'cost', label: 'Cost', render: r => formatSignedDollars(r.cost) },
  { key: 'listCost', label: 'List Cost', render: r => formatSignedDollars(r.listCost) },
  { key: 'service', label: 'Service', render: r => r.service },
  { key: 'serviceCategory', label: 'Service Category', render: r => r.serviceCategory },
  { key: 'accountId', label: 'Account ID', render: r => r.accountId },
  { key: 'accountName', label: 'Account Name', render: r => r.accountName },
  { key: 'region', label: 'Region', render: r => r.region },
  { key: 'chargeCategory', label: 'Charge Category', render: r => r.chargeCategory },
  { key: 'operation', label: 'Operation', render: r => r.operation },
  { key: 'skuMeter', label: 'SKU Meter', render: r => r.skuMeter },
  { key: 'usageAmount', label: 'Usage Amount', render: r => r.usageAmount === 0 ? '' : r.usageAmount.toLocaleString(undefined, { maximumFractionDigits: 4 }) },
  { key: 'resourceId', label: 'Resource', render: r => r.resourceId },
  { key: 'description', label: 'Description', render: r => r.description },
];

function RowDetail({ row, allColumns }: Readonly<{ row: ExplorerSampleRow; allColumns: readonly TableColumn<ExplorerSampleRow>[] }>) {
  const tagEntries = Object.entries(row.tags).filter(([, v]) => v.length > 0);
  const tagLabels = new Map(allColumns.filter(c => c.dimId?.startsWith('tag_')).map(c => [c.id, c.header]));

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-0.5 text-[11px]">
      {DETAIL_FIELDS.map(f => {
        const val = f.render(row);
        if (val.length === 0) return null;
        return (
          <div key={f.key} className="flex gap-1.5 py-0.5 min-w-0">
            <span className="text-text-muted shrink-0">{f.label}</span>
            <span className="text-text-primary truncate" title={val}>{val}</span>
          </div>
        );
      })}
      {tagEntries.map(([key, val]) => (
        <div key={key} className="flex gap-1.5 py-0.5 min-w-0">
          <span className="text-text-muted shrink-0">{tagLabels.get(key) ?? key}</span>
          <span className="text-text-primary truncate" title={val}>{val}</span>
        </div>
      ))}
    </div>
  );
}
