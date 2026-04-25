import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CostMetric,
  CostPerspective,
  CostScopeCapabilities,
  DateRange,
  Dimension,
  ExplorerFilterMap,
  ExplorerFilterValue,
  ExplorerOverviewResult,
  ExplorerRowsResult,
  ExplorerSort,
  ExplorerSortDirection,
  Granularity,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { formatDollars } from '../components/format.js';
import { DataTable, type ColumnSpec, BASE_COLUMNS, TRAILING_COLUMNS } from '../components/data-table.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { getDimensionId } from '../lib/dimensions.js';

const DEBOUNCE_MS = 250;
const ROW_LIMIT = 500;

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

export function ExplorerView(): React.JSX.Element {
  const api = useCostApi();
  const [filters, setFilters] = useState<ExplorerFilterMap>({});
  const [sort, setSort] = useState<ExplorerSort | undefined>(undefined);
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [capabilities, setCapabilities] = useState<CostScopeCapabilities | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [applyCostScope, setApplyCostScope] = useState(false);
  const [costMetric, setCostMetric] = useState<CostMetric>('unblended');
  const [costPerspective, setCostPerspective] = useState<CostPerspective>('gross');
  const [overview, setOverview] = useState<OverviewState>({ data: null, loading: true, error: null });
  const [rows, setRows] = useState<RowsState>({ data: null, loading: true, error: null });
  const [hiddenColumns, setHiddenColumns] = useState<readonly string[]>([]);
  const [columnOrder, setColumnOrder] = useState<readonly string[]>([]);
  const overviewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overviewReqIdRef = useRef(0);
  const rowsReqIdRef = useRef(0);

  useEffect(() => {
    // Store ALL dims (not just enabled). The filter bar normally hides
    // disabled dims, but it needs to fall back to the full list to render
    // chips for dims with active filters — e.g. the user clicks a Resource
    // cell and that dim is disabled-by-default high-cardinality.
    api.getDimensions().then(dims => { setDimensions(dims); }).catch(() => { setDimensions([]); });
    api.getCostScopeCapabilities().then(setCapabilities).catch(() => { setCapabilities(null); });
    api.getExplorerPreferences().then(prefs => {
      setHiddenColumns(prefs.hiddenColumns);
      setColumnOrder(prefs.columnOrder);
    }).catch(() => {
      setHiddenColumns([]);
      setColumnOrder([]);
    });
  }, [api]);

  // Persist column visibility / order on change. Fire-and-forget — the UI
  // already reflects the new state locally, so a write failure just means
  // the preference won't survive a reload (rare edge case, not worth
  // surfacing). One helper keeps both fields in sync on every save.
  function saveColumnPrefs(hidden: readonly string[], order: readonly string[]) {
    void api.saveExplorerPreferences({ hiddenColumns: hidden, columnOrder: order });
  }

  function updateHiddenColumns(next: readonly string[]) {
    setHiddenColumns(next);
    saveColumnPrefs(next, columnOrder);
  }

  function updateColumnOrder(next: readonly string[]) {
    setColumnOrder(next);
    saveColumnPrefs(hiddenColumns, next);
  }

  // Back-off from a metric / perspective the CUR doesn't support. Happens
  // when a user's CUR export drops the effective-cost or net-cost columns
  // between sessions — we downgrade silently instead of returning bogus
  // values from the server.
  useEffect(() => {
    if (capabilities === null) return;
    if (costMetric === 'amortized' && !capabilities.hasEffectiveCostColumns) setCostMetric('unblended');
    if (costMetric === 'blended' && !capabilities.hasBlendedColumn) setCostMetric('unblended');
    if (costPerspective === 'net' && !capabilities.hasNetColumns) setCostPerspective('gross');
  }, [capabilities, costMetric, costPerspective]);

  const runOverview = useCallback((
    f: ExplorerFilterMap,
    range: DateRange,
    gran: Granularity,
    scope: boolean,
    metric: CostMetric,
    perspective: CostPerspective,
  ) => {
    const reqId = ++overviewReqIdRef.current;
    setOverview(prev => ({ ...prev, loading: true, error: null }));
    api.queryExplorerOverview({
      filters: f,
      dateRange: range,
      granularity: gran,
      applyCostScope: scope,
      costMetric: metric,
      costPerspective: perspective,
    })
      .then(data => {
        if (reqId !== overviewReqIdRef.current) return;
        setOverview({ data, loading: false, error: null });
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
    perspective: CostPerspective,
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
      costPerspective: perspective,
      ...(s === undefined ? {} : { sort: s }),
    })
      .then(data => {
        if (reqId !== rowsReqIdRef.current) return;
        setRows({ data, loading: false, error: null });
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
      runOverview(filters, dateRange, granularity, applyCostScope, costMetric, costPerspective);
    }, DEBOUNCE_MS);
    return () => {
      if (overviewDebounceRef.current !== null) clearTimeout(overviewDebounceRef.current);
    };
  }, [filters, dateRange, granularity, applyCostScope, costMetric, costPerspective, runOverview]);

  // Sample rows — all overview deps PLUS sort. A sort-only change therefore
  // only re-fires this fetch, leaving the histogram alone.
  useEffect(() => {
    if (rowsDebounceRef.current !== null) clearTimeout(rowsDebounceRef.current);
    rowsDebounceRef.current = setTimeout(() => {
      runRows(filters, sort, dateRange, granularity, applyCostScope, costMetric, costPerspective);
    }, DEBOUNCE_MS);
    return () => {
      if (rowsDebounceRef.current !== null) clearTimeout(rowsDebounceRef.current);
    };
  }, [filters, sort, dateRange, granularity, applyCostScope, costMetric, costPerspective, runRows]);

  const tagColumns = overview.data?.tagColumns ?? rows.data?.tagColumns ?? [];
  // Default column list (built-ins + tags + trailing), before the user's
  // stored order is applied. Hour is daily-irrelevant so we drop it for
  // daily queries rather than showing an always-empty column.
  const defaultColumns = useMemo<readonly ColumnSpec[]>(() => [
    ...BASE_COLUMNS.filter(c => c.key !== 'usage_hour' || granularity === 'hourly'),
    ...tagColumns.map<ColumnSpec>(t => ({
      key: t.id,
      label: t.label,
      dimId: t.id,
      align: 'left',
    })),
    ...TRAILING_COLUMNS,
  ], [tagColumns, granularity]);

  // Apply the user's stored column order to the default list. Keys the
  // user has never reordered (e.g. a tag dim they added later) keep their
  // default relative position by getting appended at the end — cheaper
  // than interleaving and the user can drag them to taste.
  const availableColumns = useMemo<readonly ColumnSpec[]>(() => {
    if (columnOrder.length === 0) return defaultColumns;
    const byKey = new Map(defaultColumns.map(c => [c.key, c]));
    const seen = new Set<string>();
    const ordered: ColumnSpec[] = [];
    for (const key of columnOrder) {
      const col = byKey.get(key);
      if (col !== undefined && !seen.has(key)) {
        ordered.push(col);
        seen.add(key);
      }
    }
    for (const col of defaultColumns) {
      if (!seen.has(col.key)) ordered.push(col);
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
        if (col.dimId === dimId) keys.add(col.key);
      }
    }
    return keys;
  }, [filters, availableColumns]);

  const visibleColumns = useMemo(
    () => availableColumns.filter(c => !hiddenSet.has(c.key) && !autoHiddenSet.has(c.key)),
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

  function handleSort(columnKey: string) {
    setSort(prev => {
      if (prev?.column === columnKey) {
        const nextDir: ExplorerSortDirection = prev.direction === 'asc' ? 'desc' : 'asc';
        return { column: columnKey, direction: nextDir };
      }
      // First click: desc for numeric, asc for text. The table is a
      // raw-rows view so "biggest first" is the natural default for cost /
      // usage, while alphabetical feels right for text.
      const numericCols = new Set(['cost', 'list_cost', 'usage_amount', 'usage_date']);
      const dir: ExplorerSortDirection = numericCols.has(columnKey) ? 'desc' : 'asc';
      return { column: columnKey, direction: dir };
    });
  }

  const activeFilterCount = Object.values(filters).reduce((n, vs) => n + vs.length, 0);
  const overviewData = overview.data;

  return (
    <div className="p-6 max-w-[1800px] mx-auto space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Explorer</h1>
          <p className="text-sm text-text-secondary mt-1">
            Inspect the raw CUR dataset. Filter on any dimension, sort any column, see daily totals over the selected range.
          </p>
          {overviewData !== null && (
            <div className="mt-2 text-xs text-text-muted tabular-nums">
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
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Options</CardTitle>
        </CardHeader>
        <CardContent>
          <ExplorerOptions
            capabilities={capabilities}
            applyCostScope={applyCostScope}
            onApplyCostScopeChange={setApplyCostScope}
            costMetric={costMetric}
            onCostMetricChange={setCostMetric}
            costPerspective={costPerspective}
            onCostPerspectiveChange={setCostPerspective}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Daily total</CardTitle>
        </CardHeader>
        <CardContent>
          <Histogram days={overviewData?.dailyTotals ?? []} loading={overview.loading} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Filters</CardTitle>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
            >
              Clear all ({String(activeFilterCount)})
            </button>
          )}
        </CardHeader>
        <CardContent>
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
              costPerspective,
            })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <DataTable
            columns={visibleColumns}
            allColumns={availableColumns}
            hiddenColumns={hiddenColumns}
            autoHiddenKeys={autoHiddenSet}
            onHiddenColumnsChange={updateHiddenColumns}
            onColumnOrderChange={updateColumnOrder}
            rows={rows.data?.sampleRows ?? []}
            totalRows={overviewData?.totalRows ?? 0}
            sort={sort}
            onSort={handleSort}
            onFilterAdd={addFilterValue}
            loading={rows.loading}
            error={rows.error}
          />
        </CardContent>
      </Card>
    </div>
  );
}

interface ExplorerOptionsProps {
  readonly capabilities: CostScopeCapabilities | null;
  readonly applyCostScope: boolean;
  readonly onApplyCostScopeChange: (v: boolean) => void;
  readonly costMetric: CostMetric;
  readonly onCostMetricChange: (m: CostMetric) => void;
  readonly costPerspective: CostPerspective;
  readonly onCostPerspectiveChange: (p: CostPerspective) => void;
}

function ExplorerOptions({
  capabilities,
  applyCostScope,
  onApplyCostScopeChange,
  costMetric,
  onCostMetricChange,
  costPerspective,
  onCostPerspectiveChange,
}: ExplorerOptionsProps): React.JSX.Element {
  const metricOptions: { value: CostMetric; label: string; available: boolean }[] = [
    { value: 'unblended', label: 'Unblended', available: true },
    { value: 'blended', label: 'Blended', available: capabilities?.hasBlendedColumn !== false },
    { value: 'amortized', label: 'Amortized', available: capabilities?.hasEffectiveCostColumns !== false },
  ];
  const netAvailable = capabilities?.hasNetColumns !== false;

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
              className={[
                'flex items-center gap-1 select-none',
                opt.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
              ].join(' ')}
              title={opt.available ? undefined : 'Not available in your CUR export'}
            >
              <input
                type="radio"
                name="explorer-metric"
                className="accent-accent"
                checked={costMetric === opt.value}
                disabled={!opt.available}
                onChange={() => { onCostMetricChange(opt.value); }}
              />
              <span className="text-text-secondary">{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-text-muted">Perspective:</span>
        <div className="flex items-center gap-3">
          {(['gross', 'net'] as const).map(p => {
            const available = p === 'gross' || netAvailable;
            return (
              <label
                key={p}
                className={[
                  'flex items-center gap-1 select-none',
                  available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                ].join(' ')}
                title={available ? undefined : 'Net columns not present — enable "Include Net Columns" on the CUR'}
              >
                <input
                  type="radio"
                  name="explorer-perspective"
                  className="accent-accent"
                  checked={costPerspective === p}
                  disabled={!available}
                  onChange={() => { onCostPerspectiveChange(p); }}
                />
                <span className="text-text-secondary capitalize">{p}</span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface HistogramProps {
  readonly days: readonly { readonly date: string; readonly cost: number; readonly rows: number }[];
  readonly loading: boolean;
}

const CHART_HEIGHT = 200;
const Y_AXIS_WIDTH = 48;
const Y_TICKS = [1, 0.75, 0.5, 0.25, 0] as const;

/** Time-series histogram for the Explorer. Matches the visual style of the
 *  main dashboard's StackedBarChart (Y-axis ticks, grid, hover tooltip)
 *  but single-series — Explorer doesn't split the total, it's raw counts
 *  over time. Bucket width follows whatever the handler emits (day or
 *  hour), so the same component handles daily and hourly granularities. */
function Histogram({ days, loading }: HistogramProps): React.JSX.Element {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

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
          className="absolute top-0 right-0 h-full flex items-end"
          style={{ left: Y_AXIS_WIDTH, gap: 2 }}
        >
          {days.map(d => {
            const pct = (d.cost / max) * 100;
            const isHovered = hoveredKey === d.date;
            return (
              <div
                key={d.date}
                className="group relative flex-1 min-w-0 flex flex-col justify-end"
                style={{ height: '100%' }}
                onMouseEnter={() => { setHoveredKey(d.date); }}
                onMouseLeave={() => { setHoveredKey(null); }}
              >
                <div
                  className={[
                    'w-full rounded-t-sm transition-colors',
                    isHovered ? 'bg-accent' : 'bg-accent/80',
                  ].join(' ')}
                  style={{ height: `${String(Math.max(pct, 0.5))}%` }}
                />
                {isHovered && (
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
        </div>
      </div>

      {/* X-axis labels */}
      <div className="flex" style={{ paddingLeft: Y_AXIS_WIDTH, gap: 2 }}>
        {days.map((d, idx) => (
          <div key={d.date} className="flex-1 min-w-0 text-center overflow-hidden">
            {idx % labelStep === 0 && (
              <span className="text-[10px] text-text-muted whitespace-nowrap">
                {formatBucketLabel(d.date)}
              </span>
            )}
          </div>
        ))}
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
        const chipLabel = active.length === 0
          ? dim.label
          : active.length === 1
            ? `${dim.label}: ${active[0] ?? ''}`
            : `${dim.label} · ${String(active.length)}`;
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

