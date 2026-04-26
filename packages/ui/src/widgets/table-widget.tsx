import { useCallback, useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { DataTable, buildAllColumns, applyColumnOrder } from '../components/data-table.js';
import { asDimensionId, asTagValue, OVERVIEW_SEED_VIEW } from '@costgoblin/core/browser';
import type { AggregatedTableRow, ExplorerFilterMap, ExplorerSort, ExplorerSortDirection } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters } from './widget.js';

const ROW_LIMIT = 500;

const NUMERIC_SORT_KEYS = new Set(['cost', 'list_cost', 'usage_amount', 'usage_date']);

const SEED_TABLE = OVERVIEW_SEED_VIEW.rows.flatMap(r => r.widgets).find(w => w.type === 'table');
const DEFAULT_ENABLED = SEED_TABLE?.type === 'table' ? (SEED_TABLE.enabledColumns ?? []) : ['cost', 'resource_id', 'description'];

export function TableWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  if (spec.type !== 'table') return null;

  const specEnabled = spec.enabledColumns ?? DEFAULT_ENABLED;

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
  const [enabledColumns, setEnabledColumns] = useState(specEnabled);

  const overviewQuery = useQuery(
    () => api.queryExplorerOverview({ filters: explorerFilters, dateRange, granularity }),
    [fk, dateRange.start, dateRange.end, granularity, api],
  );

  const tagColumns = overviewQuery.status === 'success' ? overviewQuery.data.tagColumns : [];
  const totalRows = overviewQuery.status === 'success' ? overviewQuery.data.totalRows : 0;

  const allColumns = useMemo(
    () => buildAllColumns(tagColumns, granularity),
    [tagColumns, granularity],
  );

  const enabledSet = useMemo(() => new Set(enabledColumns), [enabledColumns]);

  const groupByColumns = useMemo(
    () => allColumns.filter(c => c.dimId !== null && enabledSet.has(c.key)).map(c => c.key),
    [allColumns, enabledSet],
  );

  const groupByKey = groupByColumns.join(',');

  const dataQuery = useQuery(
    () => api.queryAggregatedTable({
      filters: explorerFilters,
      dateRange,
      granularity,
      groupByColumns,
      ...(sort !== undefined ? { sort } : {}),
      rowLimit: ROW_LIMIT,
    }),
    [fk, dateRange.start, dateRange.end, granularity, groupByKey, sort?.column, sort?.direction, api],
  );

  const visibleColumns = useMemo(() => {
    const enabled = allColumns.filter(c => enabledSet.has(c.key));
    return applyColumnOrder(enabled, [...enabledColumns]);
  }, [allColumns, enabledSet, enabledColumns]);

  const hiddenColumns = useMemo(
    () => allColumns.filter(c => !enabledSet.has(c.key)).map(c => c.key),
    [allColumns, enabledSet],
  );

  const emptySet = useMemo(() => new Set<string>(), []);

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

  const handleHiddenChange = useCallback((nextHidden: readonly string[]) => {
    const hiddenSet = new Set(nextHidden);
    setEnabledColumns(allColumns.filter(c => !hiddenSet.has(c.key)).map(c => c.key));
  }, [allColumns]);

  const handleOrderChange = useCallback(() => {
    // no-op: column order controlled by enabledColumns in views editor
  }, []);

  const fetchDetailRows = useCallback(async (row: AggregatedTableRow) => {
    const detailFilters: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(explorerFilters)) {
      detailFilters[k] = v;
    }
    for (const [k, v] of Object.entries(row.values)) {
      if (v.length > 0) detailFilters[k] = [v];
    }
    const result = await api.queryExplorerRows({
      filters: detailFilters,
      dateRange,
      granularity,
      rowLimit: 100,
    });
    return result.sampleRows;
  }, [api, explorerFilters, dateRange, granularity]);

  const rows = dataQuery.status === 'success' ? dataQuery.data.rows : [];
  const aggregatedTotal = dataQuery.status === 'success' ? dataQuery.data.totalRows : totalRows;
  const loading = dataQuery.status === 'loading' || overviewQuery.status === 'loading';
  const error = dataQuery.status === 'error' ? dataQuery.error.message : null;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden p-4">
      {spec.title !== undefined && (
        <h3 className="text-sm font-medium text-text-secondary mb-3">{spec.title}</h3>
      )}
      <DataTable
        columns={visibleColumns}
        allColumns={allColumns}
        hiddenColumns={hiddenColumns}
        autoHiddenKeys={emptySet}
        onHiddenColumnsChange={handleHiddenChange}
        onColumnOrderChange={handleOrderChange}
        rows={rows}
        totalRows={aggregatedTotal}
        sort={sort}
        onSort={handleSort}
        onFilterAdd={handleFilterAdd}
        loading={loading}
        error={error}
        maxHeight="400px"
        fetchDetailRows={fetchDetailRows}
      />
    </div>
  );
}
