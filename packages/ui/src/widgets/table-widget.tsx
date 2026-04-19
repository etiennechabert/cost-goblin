import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars } from '../components/format.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult, TableColumn } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';

interface BreakdownRow {
  readonly entity: string;
  readonly service: string;
  readonly cost: number;
  readonly percentage: number;
}

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

const COLUMN_LABELS: Readonly<Record<TableColumn, string>> = {
  entity: 'Entity',
  service: 'Service',
  serviceFamily: 'Service Family',
  cost: 'Cost',
  percentage: '%',
};

const DEFAULT_COLUMNS: readonly TableColumn[] = ['entity', 'service', 'cost', 'percentage'];

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
  const cols = spec.columns ?? DEFAULT_COLUMNS;

  const entityLabel = dimensionLabelFor(dimensions, specGroupBy);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-sm font-medium text-text-secondary">{spec.title ?? 'Breakdown'}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-secondary">
              {cols.map(c => (
                <th
                  key={c}
                  className={`px-5 pb-2 pt-3 font-medium ${c === 'cost' || c === 'percentage' ? 'text-right' : ''}`}
                >
                  {c === 'entity' ? entityLabel : COLUMN_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.entity}-${r.service}-${String(i)}`}
                className="border-b border-border-subtle hover:bg-bg-tertiary/20 transition-colors cursor-pointer"
                onClick={() => { onSetFilter(specGroupBy, asTagValue(r.entity)); }}
              >
                {cols.map(c => {
                  switch (c) {
                    case 'entity':
                      return <td key={c} className="px-5 py-2 text-text-primary">{r.entity}</td>;
                    case 'service':
                      return <td key={c} className="px-5 py-2 text-text-secondary">{r.service}</td>;
                    case 'serviceFamily':
                      return <td key={c} className="px-5 py-2 text-text-secondary">—</td>;
                    case 'cost':
                      return (
                        <td key={c} className="px-5 py-2 text-right tabular-nums text-text-primary font-medium">
                          {formatDollars(r.cost)}
                        </td>
                      );
                    case 'percentage':
                      return (
                        <td key={c} className="px-5 py-2 text-right tabular-nums text-text-secondary">
                          {r.percentage.toFixed(1)}%
                        </td>
                      );
                  }
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
