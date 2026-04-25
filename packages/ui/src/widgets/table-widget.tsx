import { useCallback, useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { DataTable, buildAllColumns, applyColumnOrder, filterVisibleColumns } from '../components/data-table.js';
import { asDimensionId, asTagValue } from '@costgoblin/core/browser';
import type { ExplorerFilterMap, ExplorerSort, ExplorerSortDirection } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters } from './widget.js';

const ROW_LIMIT = 500;

const NUMERIC_SORT_KEYS = new Set(['cost', 'list_cost', 'usage_amount', 'usage_date']);

export function TableWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  if (spec.type !== 'table') return null;

  const widgetFilters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(widgetFilters);

  const explorerFilters = useMemo<ExplorerFilterMap>(() => {
    const map: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(widgetFilters)) {
      if (v !== undefined) map[k] = [v];
    }
    return map;
  }, [widgetFilters]);

  const [sort, setSort] = useState<ExplorerSort | undefined>(undefined);
  const [hiddenColumns, setHiddenColumns] = useState(spec.hiddenColumns ?? []);
  const [columnOrder, setColumnOrder] = useState(spec.columnOrder ?? []);

  const overviewQuery = useQuery(
    () => api.queryExplorerOverview({ filters: explorerFilters, dateRange, granularity }),
    [fk, dateRange.start, dateRange.end, granularity, api],
  );

  const rowsQuery = useQuery(
    () => api.queryExplorerRows({ filters: explorerFilters, dateRange, granularity, ...(sort !== undefined ? { sort } : {}), rowLimit: ROW_LIMIT }),
    [fk, dateRange.start, dateRange.end, granularity, sort?.column, sort?.direction, api],
  );

  const tagColumns = overviewQuery.status === 'success' ? overviewQuery.data.tagColumns : [];
  const totalRows = overviewQuery.status === 'success' ? overviewQuery.data.totalRows : 0;

  const allColumns = useMemo(
    () => buildAllColumns(tagColumns, granularity),
    [tagColumns, granularity],
  );

  const orderedColumns = useMemo(
    () => applyColumnOrder(allColumns, columnOrder),
    [allColumns, columnOrder],
  );

  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const emptySet = useMemo(() => new Set<string>(), []);

  const visibleColumns = useMemo(
    () => filterVisibleColumns(orderedColumns, hiddenSet, emptySet),
    [orderedColumns, hiddenSet, emptySet],
  );

  const handleSort = useCallback((columnKey: string) => {
    setSort(prev => {
      if (prev?.column === columnKey) {
        const next: ExplorerSortDirection = prev.direction === 'asc' ? 'desc' : 'asc';
        return { column: columnKey, direction: next };
      }
      return { column: columnKey, direction: NUMERIC_SORT_KEYS.has(columnKey) ? 'desc' : 'asc' };
    });
  }, []);

  const handleFilterAdd = useCallback((dimId: string, value: string) => {
    onSetFilter(asDimensionId(dimId), asTagValue(value));
  }, [onSetFilter]);

  const rows = rowsQuery.status === 'success' ? rowsQuery.data.sampleRows : [];
  const loading = rowsQuery.status === 'loading' || overviewQuery.status === 'loading';
  const error = rowsQuery.status === 'error' ? rowsQuery.error.message : null;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden p-4">
      {spec.title !== undefined && (
        <h3 className="text-sm font-medium text-text-secondary mb-3">{spec.title}</h3>
      )}
      <DataTable
        columns={visibleColumns}
        allColumns={orderedColumns}
        hiddenColumns={hiddenColumns}
        autoHiddenKeys={emptySet}
        onHiddenColumnsChange={setHiddenColumns}
        onColumnOrderChange={setColumnOrder}
        rows={rows}
        totalRows={totalRows}
        sort={sort}
        onSort={handleSort}
        onFilterAdd={handleFilterAdd}
        loading={loading}
        error={error}
        maxHeight="400px"
      />
    </div>
  );
}
