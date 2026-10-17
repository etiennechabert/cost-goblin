import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { DataTable, buildAllColumns, applyColumnOrder } from '../components/data-table.js';
import type { ColumnSpec } from '../components/data-table.js';
import { formatDollars } from '../components/format.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { asDimensionId, asTagValue, OVERVIEW_SEED_VIEW } from '@costgoblin/core/browser';
import type { AggregatedTableRow, ExplorerSort } from '@costgoblin/core/browser';
import type { SortingState } from '@tanstack/react-table';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey } from './widget.js';
import { getDimensionId } from '../lib/dimensions.js';
import { toExplorerFilters } from '../lib/agg-column.js';
import type { TableColumn } from '../lib/table-types.js';

const ROW_LIMIT = 500;

const SEED_TABLE = OVERVIEW_SEED_VIEW.rows.flatMap(r => r.widgets).find(w => w.type === 'table');
const DEFAULT_ENABLED = SEED_TABLE?.type === 'table' ? (SEED_TABLE.enabledColumns ?? []) : ['cost', 'resource_id', 'description'];

function formatSignedDollars(n: number): string {
  if (n < 0) return `-${formatDollars(-n)}`;
  return formatDollars(n);
}

function specToTableColumn(spec: ColumnSpec, activeDimIds: ReadonlySet<string>): TableColumn<AggregatedTableRow> {
  return {
    id: spec.key,
    header: spec.label,
    dimId: spec.dimId,
    clickable: spec.dimId !== null && activeDimIds.has(spec.dimId),
    align: spec.align,
    mono: spec.mono,
    truncate: spec.truncate,
    accessorFn: (row: AggregatedTableRow) => {
      switch (spec.key) {
        case 'cost': return row.cost;
        case 'list_cost': return row.listCost;
        case 'usage_amount': return row.usageAmount;
        default: return row.values[spec.key] ?? '';
      }
    },
    cell: (value: unknown) => {
      switch (spec.key) {
        case 'cost': {
          const n = value as number;
          const cls = n < 0 ? 'text-warning' : '';
          return <span className={cls}>{formatSignedDollars(n)}</span>;
        }
        case 'list_cost': return formatSignedDollars(value as number);
        case 'usage_amount': {
          const n = value as number;
          return n === 0 ? '' : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
        }
        default: return String(value);
      }
    },
  };
}

function renderDeltaCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return '';
  const v = value as number;
  const innerColor = v < 0 ? 'text-positive' : 'text-text-secondary';
  const color = v > 0 ? 'text-negative' : innerColor;
  return <span className={`${color} text-[11px]`}>{v >= 0 ? '↑' : '↓'}{Math.abs(v).toFixed(1)}%</span>;
}

/** A row's values as one string. As JSON, a value holding a separator can't
 *  read as two values. */
function rowValuesKey(values: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

/** The groups a result shows, as the `rowKeys` asking another period for
 *  their costs: each group once, in key order, so the same groups always
 *  make the same request. */
interface ShownGroups {
  readonly keys: readonly Readonly<Record<string, string>>[];
  readonly signature: string;
}

function shownGroupsOf(rows: readonly AggregatedTableRow[]): ShownGroups {
  const byKey = new Map<string, Readonly<Record<string, string>>>();
  for (const row of rows) byKey.set(rowValuesKey(row.values), row.values);
  const sorted = [...byKey].sort(([a], [b]) => a.localeCompare(b));
  return { keys: sorted.map(([, values]) => values), signature: sorted.map(([key]) => key).join('\n') };
}

/** A value and the query inputs it was loaded for. */
interface Loaded<T> {
  readonly inputs: string;
  readonly value: T;
}

/** The last value loaded, as long as it was loaded for `inputs`: it stays
 *  through a reload for the same inputs, and goes once they change. */
function useLastLoaded<T>(loaded: Loaded<T> | null, inputs: string): T | null {
  const [last, setLast] = useState<Loaded<T> | null>(loaded);
  if (loaded !== null && loaded !== last) setLast(loaded);
  return last !== null && last.inputs === inputs ? last.value : null;
}

const NO_COSTS: ReadonlyMap<string, number> = new Map();
const NO_ROWS: readonly AggregatedTableRow[] = [];

export function TableWidget({
  spec,
  dateRange,
  previousDateRange,
  compareEnabled,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();

  const specEnabled = spec.type === 'table' ? (spec.enabledColumns ?? DEFAULT_ENABLED) : DEFAULT_ENABLED;

  const fk = filtersKey(globalFilters);

  const explorerFilters = useMemo(() => toExplorerFilters(globalFilters), [globalFilters]);

  const [sort, setSort] = useState<ExplorerSort | undefined>(undefined);
  const [enabledColumns, setEnabledColumns] = useState(specEnabled);

  const overviewQuery = useQuery(
    () => api.queryExplorerOverview({ filters: explorerFilters, dateRange, granularity, applyCostScope: true, origin: 'widget:table:overview' }),
    [fk, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, granularity, api],
  );

  const tagColumns = overviewQuery.status === 'success' ? overviewQuery.data.tagColumns : [];
  const totalRows = overviewQuery.status === 'success' ? overviewQuery.data.totalRows : 0;

  const allColumnSpecs = useMemo(
    () => buildAllColumns(tagColumns, granularity),
    [tagColumns, granularity],
  );

  const enabledSet = useMemo(() => new Set(enabledColumns), [enabledColumns]);

  const groupByColumns = useMemo(
    () => allColumnSpecs.filter(c => c.dimId !== null && enabledSet.has(c.key)).map(c => c.key),
    [allColumnSpecs, enabledSet],
  );

  const groupByKey = groupByColumns.join(',');

  // What each period's rows depend on apart from the sort and the groups
  // asked for. A result carries the inputs it was fetched for: right after
  // they change, the last result is still on hand for a render.
  const rowsInputs = JSON.stringify([fk, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, granularity, groupByKey]);
  const prevInputs = JSON.stringify([fk, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, granularity, groupByKey]);

  const dataQuery = useQuery(
    () => api.queryAggregatedTable({
      filters: explorerFilters,
      dateRange,
      granularity,
      applyCostScope: true,
      groupByColumns,
      ...(sort === undefined ? {} : { sort }),
      rowLimit: ROW_LIMIT,
      origin: 'widget:table:rows',
    }).then(result => ({ result, inputs: rowsInputs })),
    [fk, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, granularity, groupByKey, sort?.column, sort?.direction, api],
  );

  // Kept while a re-sort reloads the rows: when the new order shows the same
  // groups, the previous period isn't fetched again.
  const loadedGroups = useMemo(
    () => (compareEnabled && dataQuery.status === 'success'
      ? { inputs: dataQuery.data.inputs, value: shownGroupsOf(dataQuery.data.result.rows) }
      : null),
    [compareEnabled, dataQuery],
  );
  const shownGroups = useLastLoaded(loadedGroups, rowsInputs);

  const prevDataQuery = useQuery(
    () => compareEnabled && shownGroups !== null && shownGroups.keys.length > 0
      ? api.queryAggregatedTable({
          filters: explorerFilters,
          dateRange: previousDateRange,
          granularity,
          applyCostScope: true,
          groupByColumns,
          // The groups on screen rather than the top ones by cost: past the
          // row limit those leave out the credits a cost-ascending sort shows.
          rowKeys: shownGroups.keys,
          rowLimit: ROW_LIMIT,
          origin: 'widget:table:rows/prev',
        }).then(result => ({ result, inputs: prevInputs }))
      : Promise.resolve(null),
    [compareEnabled, fk, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, granularity, groupByKey, shownGroups?.signature, api],
  );

  const loadedPrevCosts = useMemo(() => {
    if (prevDataQuery.status !== 'success' || prevDataQuery.data === null) return null;
    const costs = new Map<string, number>();
    for (const row of prevDataQuery.data.result.rows) costs.set(rowValuesKey(row.values), row.cost);
    return { inputs: prevDataQuery.data.inputs, value: costs };
  }, [prevDataQuery]);
  // Kept while the previous period reloads for newly shown groups: the costs
  // already loaded still hold, and the column doesn't blink out meanwhile.
  const prevCostMap = useLastLoaded(loadedPrevCosts, prevInputs) ?? NO_COSTS;

  const activeDimIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of dimensions) ids.add(getDimensionId(d));
    return ids;
  }, [dimensions]);

  const allTableColumns = useMemo(
    () => allColumnSpecs.map(s => specToTableColumn(s, activeDimIds)),
    [allColumnSpecs, activeDimIds],
  );

  const deltaColumn = useMemo<TableColumn<AggregatedTableRow> | null>(() => {
    if (!compareEnabled || prevCostMap.size === 0) return null;
    return {
      id: '__delta_pct',
      header: 'Δ%',
      dimId: null,
      clickable: false,
      align: 'right' as const,
      mono: true,
      accessorFn: (row: AggregatedTableRow) => {
        const prev = prevCostMap.get(rowValuesKey(row.values));
        if (prev === undefined || prev === 0) return null;
        // Against the previous cost's size, so the sign follows the change
        // even from a net credit: -$100 → -$150 is a 50% saving.
        return ((row.cost - prev) / Math.abs(prev)) * 100;
      },
      cell: renderDeltaCell,
    };
  }, [compareEnabled, prevCostMap]);

  const rows = useMemo(() => (dataQuery.status === 'success' ? dataQuery.data.result.rows : NO_ROWS), [dataQuery]);
  // A new array whenever the previous costs change: the table keeps each
  // row's cell values until its data changes, and the Δ% reads those costs.
  const tableRows = useMemo(() => [...rows], [rows, prevCostMap]);

  const visibleTableColumns = useMemo(() => {
    const enabled = allColumnSpecs.filter(c => enabledSet.has(c.key));
    const ordered = applyColumnOrder(enabled, [...enabledColumns]);
    const cols = ordered.map(s => specToTableColumn(s, activeDimIds));
    if (deltaColumn !== null) {
      const costIdx = cols.findIndex(c => c.id === 'cost');
      cols.splice(costIdx + 1, 0, deltaColumn);
    }
    return cols;
  }, [allColumnSpecs, enabledSet, enabledColumns, activeDimIds, deltaColumn]);

  const hiddenColumns = useMemo(
    () => allColumnSpecs.filter(c => !enabledSet.has(c.key)).map(c => c.key),
    [allColumnSpecs, enabledSet],
  );

  const emptyAutoHidden = useMemo(() => new Set<string>(), []);

  const tanstackSorting = useMemo<SortingState>(() => {
    if (sort === undefined) return [];
    return [{ id: sort.column, desc: sort.direction === 'desc' }];
  }, [sort]);

  const handleSortingChange = useCallback((state: SortingState) => {
    if (state.length === 0) {
      setSort(undefined);
    } else {
      const first = state[0];
      if (first !== undefined) {
        setSort({ column: first.id, direction: first.desc ? 'desc' : 'asc' });
      }
    }
  }, []);

  const handleCellClick = useCallback((_row: AggregatedTableRow, columnId: string, value: unknown) => {
    const col = allColumnSpecs.find(c => c.key === columnId);
    if (col?.dimId !== undefined && col.dimId !== null && activeDimIds.has(col.dimId) && typeof value === 'string' && value.length > 0) {
      onSetFilter(asDimensionId(col.dimId), asTagValue(value));
    }
  }, [allColumnSpecs, onSetFilter, activeDimIds]);

  const handleHiddenChange = useCallback((nextHidden: readonly string[]) => {
    const hiddenSet = new Set(nextHidden);
    setEnabledColumns(allColumnSpecs.filter(c => !hiddenSet.has(c.key)).map(c => c.key));
  }, [allColumnSpecs]);

  const handleOrderChange = useCallback(() => {
    // no-op: column order controlled by enabledColumns in views editor
  }, []);

  const fetchDetailRows = useCallback(async (row: AggregatedTableRow) => {
    const allDimKeys = allColumnSpecs.filter(c => c.dimId !== null).map(c => c.key);
    const result = await api.queryAggregatedTable({
      filters: explorerFilters,
      dateRange,
      granularity,
      applyCostScope: true,
      groupByColumns: allDimKeys,
      rowLimit: 100,
      rowFilters: row.values,
      origin: 'widget:table:expand',
    });
    return result.rows;
  }, [api, explorerFilters, dateRange, granularity, allColumnSpecs]);

  const renderExpandedRow = useCallback((row: AggregatedTableRow) => (
    <RowDetail
      row={row}
      allColumns={allColumnSpecs}
      fetchDetailRows={fetchDetailRows}
    />
  ), [allColumnSpecs, fetchDetailRows]);

  if (spec.type !== 'table') return null;

  const aggregatedTotal = dataQuery.status === 'success' ? dataQuery.data.result.totalRows : totalRows;
  const loading = dataQuery.status === 'loading' || overviewQuery.status === 'loading';
  const error = dataQuery.status === 'error' ? dataQuery.error.message : null;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden p-4">
      {spec.title !== undefined && (
        <h3 className="text-sm font-medium text-text-secondary mb-3">{spec.title}</h3>
      )}
      <DataTable<AggregatedTableRow>
        data={tableRows}
        columns={visibleTableColumns}
        allColumns={allTableColumns}
        hiddenColumns={hiddenColumns}
        autoHiddenKeys={emptyAutoHidden}
        onHiddenColumnsChange={handleHiddenChange}
        onColumnOrderChange={handleOrderChange}
        sorting={tanstackSorting}
        onSortingChange={handleSortingChange}
        onCellClick={handleCellClick}
        totalRows={aggregatedTotal}
        loading={loading}
        error={error}
        height={400}
        csvFilename={`costgoblin-${spec.title ?? 'table'}-${dateRange.start}-${dateRange.end}`}
        renderExpandedRow={renderExpandedRow}
      />
    </div>
  );
}

// --- RowDetail (preserved from original, renders expanded row content) ---

function RowDetail({ row, allColumns, fetchDetailRows }: Readonly<{
  row: AggregatedTableRow;
  allColumns: readonly ColumnSpec[];
  fetchDetailRows: (r: AggregatedTableRow) => Promise<readonly AggregatedTableRow[]>;
}>) {
  const [detailRows, setDetailRows] = useState<readonly AggregatedTableRow[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    setDetailLoading(true);
    fetchDetailRows(row)
      .then(rows => { setDetailRows(rows); })
      .catch(() => { setDetailRows([]); })
      .finally(() => { setDetailLoading(false); });
  }, [row, fetchDetailRows]);

  const entries = Object.entries(row.values).filter(([, v]) => v.length > 0);
  const labelMap = new Map(allColumns.map(c => [c.key, c.label]));

  const detailColSpecs = useMemo(() => {
    if (detailRows === null || detailRows.length === 0) return [];
    const first = detailRows[0];
    if (first === undefined) return [];
    const dimCols = Object.keys(first.values)
      .map(key => allColumns.find(c => c.key === key))
      .filter((c): c is ColumnSpec => c !== undefined);
    const costCol: ColumnSpec = { key: 'cost', label: 'Cost', dimId: null, align: 'right', mono: true };
    const result = [...dimCols];
    result.splice(1, 0, costCol);
    return result;
  }, [detailRows, allColumns]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-0.5 text-[11px]">
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-1.5 py-0.5 min-w-0">
            <span className="text-text-muted shrink-0">{labelMap.get(key) ?? key}</span>
            <span className="text-text-primary truncate" title={val}>{val}</span>
          </div>
        ))}
        <div className="flex gap-1.5 py-0.5 min-w-0">
          <span className="text-text-muted shrink-0">Cost</span>
          <span className="text-text-primary">{formatSignedDollars(row.cost)}</span>
        </div>
        <div className="flex gap-1.5 py-0.5 min-w-0">
          <span className="text-text-muted shrink-0">Line Items</span>
          <span className="text-text-primary">{row.rowCount.toLocaleString()}</span>
        </div>
      </div>

      <div>
        {detailLoading && <CoinRainLoader height={80} count={3} />}
        {detailRows !== null && detailRows.length > 0 && (
          <div className="border border-border/60 rounded overflow-auto max-h-[300px]">
            <table className="text-[10px] w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-bg-tertiary/95 backdrop-blur-sm">
                <tr className="text-left text-text-muted">
                  {detailColSpecs.map(c => (
                    <th key={c.key} className={`px-2 py-1 font-medium whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailRows.map((dr) => {
                  const drKey = `${dr.values['usage_date'] ?? ''}-${dr.values['service'] ?? ''}-${String(dr.cost)}`;
                  return (
                    <tr key={drKey} className="border-t border-border/30 hover:bg-bg-tertiary/20">
                      {detailColSpecs.map(c => {
                        const val = c.key === 'cost' ? formatSignedDollars(dr.cost) : (dr.values[c.key] ?? '');
                        return (
                          <td
                            key={c.key}
                            className={`px-2 py-0.5 whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.truncate === true ? 'max-w-[200px] overflow-hidden text-ellipsis' : ''}`}
                            title={val}
                          >
                            {val}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {detailRows !== null && detailRows.length === 0 && !detailLoading && (
          <div className="text-[10px] text-text-muted text-center py-2">No detail rows available.</div>
        )}
      </div>
    </div>
  );
}
