import { useMemo, useState, useCallback } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars } from '../components/format.js';
import { asDollars, asTagValue } from '@costgoblin/core/browser';
import type { CostResult, TableColumn, TrendResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';

interface TableRow {
  readonly entity: string;
  readonly cost: number;
  readonly percentage: number;
  readonly topService: string;
  readonly previousCost: number;
  readonly delta: number;
  readonly percentChange: number;
}

const DEFAULT_COLUMNS: readonly TableColumn[] = ['entity', 'cost', 'delta', 'percentChange'];

const COLUMN_LABELS: Readonly<Record<TableColumn, string>> = {
  entity: 'Entity',
  cost: 'Cost',
  percentage: '%',
  topService: 'Top Service',
  previousCost: 'Previous',
  delta: 'Delta',
  percentChange: '% Change',
};

const NUMERIC_COLUMNS = new Set<TableColumn>(['cost', 'percentage', 'previousCost', 'delta', 'percentChange']);

type SortDir = 'asc' | 'desc';

function buildRows(
  costs: CostResult | null,
  trends: TrendResult | null,
  topN: number,
): TableRow[] {
  if (costs === null) return [];
  const total = costs.totalCost;

  const trendMap = new Map<string, { previousCost: number; delta: number; percentChange: number }>();
  if (trends !== null) {
    for (const r of [...trends.increases, ...trends.savings]) {
      trendMap.set(r.entity, { previousCost: r.previousCost, delta: r.delta, percentChange: r.percentChange });
    }
  }

  return costs.rows
    .map(r => {
      const entries = Object.entries(r.serviceCosts);
      const top = entries.length > 0
        ? entries.reduce((best, cur) => cur[1] > best[1] ? cur : best)
        : undefined;
      const trend = trendMap.get(r.entity);
      return {
        entity: r.entity as string,
        cost: r.totalCost,
        percentage: total > 0 ? (r.totalCost / total) * 100 : 0,
        topService: top !== undefined ? top[0] : '',
        previousCost: trend?.previousCost ?? 0,
        delta: trend?.delta ?? 0,
        percentChange: trend?.percentChange ?? 0,
      };
    })
    .sort((a, b) => b.cost - a.cost)
    .slice(0, topN);
}

function sortRows(rows: readonly TableRow[], col: TableColumn, dir: SortDir): TableRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
    const as = String(av);
    const bs = String(bv);
    return dir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
  });
  return sorted;
}

function formatDelta(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatDollars(n)}`;
}

function formatPct(n: number): string {
  if (n === 0) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function deltaColor(n: number): string {
  if (n > 0) return 'text-negative';
  if (n < 0) return 'text-positive';
  return 'text-text-secondary';
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
  if (spec.type !== 'table') return null;
  const specGroupBy = spec.groupBy;
  const topN = spec.topN ?? 20;
  const cols = spec.columns ?? DEFAULT_COLUMNS;
  const hasTrendCols = cols.some(c => c === 'previousCost' || c === 'delta' || c === 'percentChange');

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);

  const costQuery = useQuery(
    () => api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity }),
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const trendQuery = useQuery(
    () => hasTrendCols
      ? api.queryTrends({ groupBy: specGroupBy, dateRange, filters, deltaThreshold: asDollars(0), percentThreshold: 0 })
      : Promise.resolve(null),
    [specGroupBy, dateRange.start, dateRange.end, fk, hasTrendCols, api],
  );

  const [sortCol, setSortCol] = useState<TableColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = useCallback((col: TableColumn) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir(NUMERIC_COLUMNS.has(col) ? 'desc' : 'asc');
    }
  }, [sortCol]);

  const baseRows = useMemo(
    () => buildRows(
      costQuery.status === 'success' ? costQuery.data : null,
      trendQuery.status === 'success' ? trendQuery.data : null,
      topN,
    ),
    [costQuery, trendQuery, topN],
  );

  const rows = useMemo(
    () => sortCol !== null ? sortRows(baseRows, sortCol, sortDir) : baseRows,
    [baseRows, sortCol, sortDir],
  );

  const entityLabel = dimensionLabelFor(dimensions, specGroupBy);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-sm font-medium text-text-secondary">{spec.title ?? 'Breakdown'}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-secondary">
              {cols.map(c => {
                const isNum = NUMERIC_COLUMNS.has(c);
                const isSorted = sortCol === c;
                const arrow = isSorted ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
                return (
                  <th
                    key={c}
                    onClick={() => { handleSort(c); }}
                    className={[
                      'px-5 pb-2 pt-3 font-medium select-none cursor-pointer hover:text-text-primary transition-colors',
                      isNum ? 'text-right' : '',
                    ].join(' ')}
                  >
                    {c === 'entity' ? entityLabel : COLUMN_LABELS[c]}{arrow}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.entity}-${String(i)}`}
                className="border-b border-border-subtle hover:bg-bg-tertiary/20 transition-colors cursor-pointer"
                onClick={() => { onSetFilter(specGroupBy, asTagValue(r.entity)); }}
              >
                {cols.map(c => {
                  switch (c) {
                    case 'entity':
                      return <td key={c} className="px-5 py-2.5 text-text-primary font-medium">{r.entity}</td>;
                    case 'cost':
                      return <td key={c} className="px-5 py-2.5 text-right tabular-nums text-text-primary font-medium">{formatDollars(r.cost)}</td>;
                    case 'percentage':
                      return <td key={c} className="px-5 py-2.5 text-right tabular-nums text-text-secondary">{r.percentage.toFixed(1)}%</td>;
                    case 'topService':
                      return <td key={c} className="px-5 py-2.5 text-text-secondary">{r.topService}</td>;
                    case 'previousCost':
                      return <td key={c} className="px-5 py-2.5 text-right tabular-nums text-text-secondary">{formatDollars(r.previousCost)}</td>;
                    case 'delta':
                      return <td key={c} className={`px-5 py-2.5 text-right tabular-nums font-medium ${deltaColor(r.delta)}`}>{formatDelta(r.delta)}</td>;
                    case 'percentChange':
                      return <td key={c} className={`px-5 py-2.5 text-right tabular-nums ${deltaColor(r.percentChange)}`}>{formatPct(r.percentChange)}</td>;
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
