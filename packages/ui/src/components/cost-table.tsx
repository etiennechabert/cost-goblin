import { useMemo } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import type { CostRow, EntityRef } from '@costgoblin/core/browser';
import type { TableColumn } from '../lib/table-types.js';
import { formatDollars } from './format.js';
import { DataTable } from './data-table.js';

interface CostTableProps {
  rows: CostRow[];
  topServices: string[];
  onEntityClick: (entity: EntityRef) => void;
  onServiceClick?: (service: string) => void;
}

export function CostTable({ rows, topServices, onEntityClick, onServiceClick }: Readonly<CostTableProps>) {
  // Build column definitions dynamically based on topServices
  const columns = useMemo<Array<TableColumn<CostRow>>>(() => {
    const cols: Array<TableColumn<CostRow>> = [
      // Entity column with custom rendering for virtual folders
      {
        id: 'entity',
        label: 'Entity',
        accessorKey: 'entity',
        sortable: true,
        pinnable: true,
        cell: (row) => (
          <button
            type="button"
            className={`flex items-center gap-1.5 hover:underline ${
              row.isVirtual
                ? 'font-semibold text-warning hover:text-warning'
                : 'font-medium text-accent hover:text-accent-hover'
            }`}
            onClick={(e) => { e.stopPropagation(); onEntityClick(row.entity); }}
          >
            {row.isVirtual && (
              <>
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <ChevronRight className="h-3 w-3 shrink-0" />
              </>
            )}
            {row.entity}
          </button>
        ),
      },
      // Total cost column
      {
        id: 'totalCost',
        label: 'Total',
        accessorKey: 'totalCost',
        align: 'right',
        mono: true,
        sortable: true,
        cell: (row) => (
          <span className="font-medium text-text-primary">
            {formatDollars(row.totalCost)}
          </span>
        ),
      },
    ];

    // Add dynamic service columns
    for (const service of topServices) {
      cols.push({
        id: `service-${service}`,
        label: service,
        accessorKey: null,
        align: 'right',
        mono: true,
        sortable: true,
        cell: (row) => {
          const cost = row.serviceCosts[service];
          return (
            <span className="text-text-secondary">
              {cost === undefined ? '—' : formatDollars(cost)}
            </span>
          );
        },
      });
    }

    return cols;
  }, [topServices, onEntityClick]);

  // Default sorting: totalCost descending
  const defaultSorting = useMemo(() => [{ id: 'totalCost', desc: true }], []);

  // Handle service header clicks via onCellClick
  const handleCellClick = useMemo(() => {
    if (onServiceClick === undefined) return undefined;
    return (_row: CostRow, columnId: string) => {
      if (columnId.startsWith('service-')) {
        const service = columnId.replace('service-', '');
        onServiceClick(service);
      }
    };
  }, [onServiceClick]);

  return (
    <DataTable
      data={rows}
      columns={columns}
      sorting={defaultSorting}
      onCellClick={handleCellClick}
    />
  );
}
