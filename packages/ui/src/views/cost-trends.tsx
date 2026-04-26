import { useState } from 'react';
import type {
  Dimension,
  DimensionId,
  DateString,
  TrendResult,
  TrendRow,
  EntityRef,
} from '@costgoblin/core/browser';
import { DEFAULT_LAG_DAYS, asDimensionId, asDollars } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useQuery } from '../hooks/use-query.js';
import { daysAgo } from '../lib/dates.js';
import { getDimensionId } from '../lib/dimensions.js';
import { BubbleChart } from '../components/bubble-chart.js';
import { DimensionSelector } from '../components/dimension-selector.js';
import { formatDollars, formatPercent } from '../components/format.js';

const PERIOD_PRESETS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
] as const;

function getDateRange(days: number, lagDays: number = DEFAULT_LAG_DAYS): { start: DateString; end: DateString } {
  return { start: daysAgo(days + lagDays), end: daysAgo(lagDays) };
}

type Direction = 'increases' | 'savings';

interface TrendsState {
  selectedDimensionId: DimensionId | null;
  direction: Direction;
  periodDays: number;
  deltaThreshold: number;
  percentThreshold: number;
}

function TrendRowItem({ row, onClick }: Readonly<{ row: TrendRow; onClick: (e: EntityRef) => void }>) {
  const isIncrease = row.delta > 0;
  return (
    <tr className="border-b border-border-subtle hover:bg-bg-tertiary/30 transition-colors">
      <td className="px-4 py-3">
        <button
          type="button"
          className="font-medium text-accent hover:text-accent-hover hover:underline"
          onClick={() => { onClick(row.entity); }}
        >
          {row.entity}
        </button>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-text-primary">
        {formatDollars(row.currentCost)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
        {formatDollars(row.previousCost)}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums font-medium ${isIncrease ? 'text-negative' : 'text-positive'}`}>
        {isIncrease ? '+' : ''}{formatDollars(row.delta)}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums font-medium ${isIncrease ? 'text-negative' : 'text-positive'}`}>
        {formatPercent(row.percentChange)}
      </td>
    </tr>
  );
}

interface CostTrendsProps {
  onEntityClick?: (entity: string, dimension: string) => void;
}

export function CostTrends({ onEntityClick: onEntityClickProp }: CostTrendsProps = {}) {
  const api = useCostApi();
  const lagDays = useLagDays();
  const dimensionsQuery = useQuery(() => api.getDimensions(), []);

  const [state, setState] = useState<TrendsState>({
    selectedDimensionId: null,
    direction: 'increases',
    periodDays: 30,
    deltaThreshold: 10,
    percentThreshold: 1,
  });

  const dimensions: Dimension[] =
    dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];

  const firstDimId = dimensions.length > 0 && dimensions[0] !== undefined
    ? getDimensionId(dimensions[0])
    : null;
  const activeDimensionId = state.selectedDimensionId ?? firstDimId;

  const trendsQuery = useQuery(
    () => {
      if (activeDimensionId === null) return Promise.resolve(null);
      return api.queryTrends({
        groupBy: activeDimensionId,
        dateRange: getDateRange(state.periodDays, lagDays),
        filters: {},
        deltaThreshold: asDollars(state.deltaThreshold),
        percentThreshold: state.percentThreshold,
      });
    },
    [activeDimensionId, state.periodDays, state.deltaThreshold, state.percentThreshold, lagDays, api],
  );

  const trendData: TrendResult | null =
    trendsQuery.status === 'success' ? trendsQuery.data : null;

  let rows: readonly TrendRow[] = [];
  if (trendData !== null) {
    rows = state.direction === 'increases' ? trendData.increases : trendData.savings;
  }

  let totalLabel = '';
  if (trendData !== null) {
    totalLabel = state.direction === 'increases'
      ? `+${formatDollars(trendData.totalIncrease)} total increase`
      : `-${formatDollars(trendData.totalSavings)} total savings`;
  }

  function handleEntityClick(entity: EntityRef) {
    if (onEntityClickProp !== undefined && activeDimensionId !== null) {
      onEntityClickProp(entity, activeDimensionId);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Cost Trends</h2>
          <p className="text-sm text-text-secondary mt-1">Period-over-period comparison</p>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
          {PERIOD_PRESETS.map(p => (
            <button
              key={p.days}
              type="button"
              onClick={() => { setState(s => ({ ...s, periodDays: p.days })); }}
              className={[
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                state.periodDays === p.days
                  ? 'bg-bg-secondary text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {dimensions.length > 0 && (
        <div className="flex flex-wrap items-center gap-4">
          <DimensionSelector
            dimensions={dimensions}
            selected={activeDimensionId ?? ''}
            onSelect={(id) => { setState((p) => ({ ...p, selectedDimensionId: asDimensionId(id) })); }}
          />

          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-1">
            {(['increases', 'savings'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => { setState((p) => ({ ...p, direction: d })); }}
                className={[
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors capitalize',
                  state.direction === d
                    ? 'bg-bg-secondary text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {d}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 text-xs text-text-secondary">
            <label className="flex items-center gap-1.5">
              <span>Min $</span>
              <input
                type="number"
                value={state.deltaThreshold}
                onChange={(e) => { setState((p) => ({ ...p, deltaThreshold: Number(e.target.value) })); }}
                className="w-20 rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span>Min %</span>
              <input
                type="number"
                value={state.percentThreshold}
                onChange={(e) => { setState((p) => ({ ...p, percentThreshold: Number(e.target.value) })); }}
                className="w-16 rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
              />
            </label>
          </div>
        </div>
      )}

      {trendData !== null && (
        <div className="text-sm font-medium text-text-secondary">
          {String(rows.length)} items · {totalLabel}
        </div>
      )}

      {trendsQuery.status === 'loading' && (
        <div className="text-sm text-text-secondary">Loading trends...</div>
      )}
      {trendsQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {trendsQuery.error.message}
        </div>
      )}

      {rows.length > 0 && (
        <BubbleChart data={rows} onEntityClick={handleEntityClick} />
      )}

      {rows.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-secondary">
                <th className="px-4 pb-3 pt-4 font-medium">Entity</th>
                <th className="px-4 pb-3 pt-4 text-right font-medium">Current</th>
                <th className="px-4 pb-3 pt-4 text-right font-medium">Previous</th>
                <th className="px-4 pb-3 pt-4 text-right font-medium">Delta</th>
                <th className="px-4 pb-3 pt-4 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TrendRowItem key={row.entity} row={row} onClick={handleEntityClick} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trendData !== null && rows.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          No {state.direction} above thresholds
        </div>
      )}
    </div>
  );
}
