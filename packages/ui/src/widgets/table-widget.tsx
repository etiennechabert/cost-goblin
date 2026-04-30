import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { DataTable, buildAllColumns, applyColumnOrder } from '../components/data-table.js';
import type { ColumnSpec } from '../components/data-table.js';
import { formatDollars } from '../components/format.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { asDimensionId, asTagValue, OVERVIEW_SEED_VIEW } from '@costgoblin/core/browser';
import type { AggregatedTableRow, ExplorerFilterMap, ExplorerSort } from '@costgoblin/core/browser';
import type { SortingState } from '@tanstack/react-table';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters } from './widget.js';
import { getDimensionId } from '../lib/dimensions.js';
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

export function TableWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();

  const specEnabled = spec.type === 'table' ? (spec.enabledColumns ?? DEFAULT_ENABLED) : DEFAULT_ENABLED;

  const widgetFilters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(widgetFilters);

  const explorerFilters = useMemo<ExplorerFilterMap>(() => {
    const map: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(widgetFilters)) {
      if (v !== undefined) map[k] = v;
    }
    return map;
  }, [widgetFilters]);

  const [sort, setSort] = useState<ExplorerSort | undefined>(undefined);
  const [enabledColumns, setEnabledColumns] = useState(specEnabled);

  const overviewQuery = useQuery(
    () => api.queryExplorerOverview({ filters: explorerFilters, dateRange, granularity }),
    [fk, dateRange.start, dateRange.end, granularity, api],
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

  const dataQuery = useQuery(
    () => api.queryAggregatedTable({
      filters: explorerFilters,
      dateRange,
      granularity,
      groupByColumns,
      ...(sort === undefined ? {} : { sort }),
      rowLimit: ROW_LIMIT,
    }),
    [fk, dateRange.start, dateRange.end, granularity, groupByKey, sort?.column, sort?.direction, api],
  );

  const activeDimIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of dimensions) ids.add(getDimensionId(d));
    return ids;
  }, [dimensions]);

  const allTableColumns = useMemo(
    () => allColumnSpecs.map(s => specToTableColumn(s, activeDimIds)),
    [allColumnSpecs, activeDimIds],
  );

  const visibleTableColumns = useMemo(() => {
    const enabled = allColumnSpecs.filter(c => enabledSet.has(c.key));
    const ordered = applyColumnOrder(enabled, [...enabledColumns]);
    return ordered.map(s => specToTableColumn(s, activeDimIds));
  }, [allColumnSpecs, enabledSet, enabledColumns, activeDimIds]);

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
      groupByColumns: allDimKeys,
      rowLimit: 100,
      rowFilters: row.values,
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

  const rows = dataQuery.status === 'success' ? dataQuery.data.rows : [];
  const aggregatedTotal = dataQuery.status === 'success' ? dataQuery.data.totalRows : totalRows;
  const loading = dataQuery.status === 'loading' || overviewQuery.status === 'loading';
  const error = dataQuery.status === 'error' ? dataQuery.error.message : null;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden p-4">
      {spec.title !== undefined && (
        <h3 className="text-sm font-medium text-text-secondary mb-3">{spec.title}</h3>
      )}
      <DataTable<AggregatedTableRow>
        data={rows}
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

  function formatSignedDollarsInline(n: number): string {
    if (n < 0) return `-${formatDollars(-n)}`;
    return formatDollars(n);
  }

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
          <span className="text-text-primary">{formatSignedDollarsInline(row.cost)}</span>
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
                        const val = c.key === 'cost' ? formatSignedDollarsInline(dr.cost) : (dr.values[c.key] ?? '');
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
