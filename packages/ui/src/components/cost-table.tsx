import { ChevronRight, Folder } from 'lucide-react';
import type { CostRow, EntityRef } from '@costgoblin/core/browser';
import { formatDollars } from './format.js';

interface CostTableProps {
  rows: CostRow[];
  topServices: string[];
  onEntityClick: (entity: EntityRef) => void;
  onServiceClick?: (service: string) => void;
}

export function CostTable({ rows, topServices, onEntityClick, onServiceClick }: Readonly<CostTableProps>) {
  const sorted = [...rows].sort((a, b) => b.totalCost - a.totalCost);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-secondary">
            <th className="px-4 pb-3 pt-4 font-medium">Entity</th>
            <th className="px-4 pb-3 pt-4 text-right font-medium">Total</th>
            {topServices.map((service) => (
              <th key={service} className="px-4 pb-3 pt-4 text-right font-medium">
                {onServiceClick === undefined ? service : (
                  <button
                    type="button"
                    className="hover:text-text-primary transition-colors"
                    onClick={() => { onServiceClick(service); }}
                  >
                    {service}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.entity}
              className="border-b border-border-subtle hover:bg-bg-tertiary/30 transition-colors cursor-pointer"
            >
              <td className="px-4 py-3">
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
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium text-text-primary">
                {formatDollars(row.totalCost)}
              </td>
              {topServices.map((service) => {
                const cost = row.serviceCosts[service];
                return (
                  <td key={service} className="px-4 py-3 text-right tabular-nums text-text-secondary">
                    {cost === undefined ? '—' : formatDollars(cost)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
