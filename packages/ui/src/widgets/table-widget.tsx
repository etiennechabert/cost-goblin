import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars } from '../components/format.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';

interface BreakdownRow {
  readonly entity: string;
  readonly service: string;
  readonly cost: number;
  readonly percentage: number;
}

type WidgetColumnId = 'entity' | 'service' | 'serviceFamily' | 'cost' | 'percentage';

function buildRows(data: CostResult | null, topN: number): BreakdownRow[] {
  if (data === null) return [];
  const total = data.totalCost;
  return data.rows
    .flatMap(r =>
      Object.entries(r.serviceCosts).map(([svc, cost]) => ({
        entity: r.entity,
        service: svc,
        cost: cost,
        percentage: total > 0 ? (cost / total) * 100 : 0,
      })),
    )
    .sort((a, b) => b.cost - a.cost)
    .slice(0, topN);
}

function buildColumns(
  entityLabel: string,
  specGroupBy: string,
  requestedColumns: readonly WidgetColumnId[],
): Array<TableColumn<BreakdownRow>> {
  const allColumns: Readonly<Record<WidgetColumnId, TableColumn<BreakdownRow>>> = {
    entity: {
      id: 'entity',
      label: entityLabel,
      accessorKey: 'entity',
      align: 'left',
      dimId: specGroupBy,
      sortable: true,
    },
    service: {
      id: 'service',
      label: 'Service',
      accessorKey: 'service',
      align: 'left',
      sortable: true,
    },
    serviceFamily: {
      id: 'serviceFamily',
      label: 'Service Family',
      accessorKey: null,
      cell: () => '—',
      align: 'left',
      sortable: false,
    },
    cost: {
      id: 'cost',
      label: 'Cost',
      accessorKey: 'cost',
      cell: (row) => formatDollars(row.cost),
      align: 'right',
      mono: true,
      sortable: true,
    },
    percentage: {
      id: 'percentage',
      label: '%',
      accessorKey: 'percentage',
      cell: (row) => `${row.percentage.toFixed(1)}%`,
      align: 'right',
      mono: true,
      sortable: true,
    },
  };

  return requestedColumns.map(colId => allColumns[colId]);
}

const DEFAULT_COLUMNS: readonly WidgetColumnId[] = ['entity', 'service', 'cost', 'percentage'];

export function TableWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  if (spec.type !== 'table') return null;
  const specGroupBy = spec.groupBy;
  const topN = spec.topN ?? 20;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const query = useQuery(
    () => api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity }),
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const rows = useMemo(
    () => buildRows(query.status === 'success' ? query.data : null, topN),
    [query, topN],
  );
  const requestedCols = (spec.columns ?? DEFAULT_COLUMNS) as readonly WidgetColumnId[];

  const entityLabel = dimensionLabelFor(dimensions, specGroupBy);

  const columns = useMemo(
    () => buildColumns(entityLabel, specGroupBy, requestedCols),
    [entityLabel, specGroupBy, requestedCols],
  );

  const handleCellClick = (_row: BreakdownRow, columnId: string, value: unknown) => {
    // Only add filter when clicking the entity column
    if (columnId === 'entity' && typeof value === 'string') {
      onSetFilter(specGroupBy, asTagValue(value));
    }
  };

  const isLoading = query.status === 'loading';
  const error = query.status === 'error' ? query.error.message : null;

  if (rows.length === 0 && !isLoading && error === null) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-sm font-medium text-text-secondary">{spec.title ?? 'Breakdown'}</h3>
      </div>
      <DataTable
        data={rows}
        columns={columns}
        loading={isLoading}
        error={error}
        emptyMessage="No cost data available"
        onCellClick={handleCellClick}
      />
    </div>
  );
}
