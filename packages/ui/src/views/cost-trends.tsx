import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Dimension,
  DimensionId,
  RollupStatus,
  TrendResult,
  TrendRow,
  EntityRef,
} from '@costgoblin/core/browser';
import { asDimensionId, asDollars, asEntityRef } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useQuery } from '../hooks/use-query.js';
import { getDimensionId } from '../lib/dimensions.js';
import { rollupGate } from '../lib/rollup-gate.js';
import { BubbleChart } from '../components/bubble-chart.js';
import { RollupBuildingOverlay } from '../components/rollup-building-overlay.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';
import { DimensionSelector } from '../components/dimension-selector.js';
import { formatDollars, formatPercent } from '../components/format.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';

type Direction = 'all' | 'increases' | 'savings';

const DIRECTION_OPTIONS: readonly { value: Direction; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'increases', label: 'Increase' },
  { value: 'savings', label: 'Savings' },
];

interface TrendsState {
  selectedDimensionId: DimensionId | null;
  direction: Direction;
  dateRange: DateRange;
  granularity: Granularity;
  deltaThreshold: number;
  percentThreshold: number;
  logScale: number | 'linear';
}

const SCALE_OPTIONS: readonly { value: number | 'linear'; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 2, label: 'Log 2' },
  { value: 10, label: 'Log 10' },
];

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
  /** Live rollup state — Cost Trends is rollup-backed, so a cold first build
   *  blocks with the build overlay until the viewed period is aggregated. */
  rollupStatus?: RollupStatus;
  rollupEverReady?: boolean;
}

export function CostTrends({ onEntityClick: onEntityClickProp, rollupStatus, rollupEverReady }: CostTrendsProps = {}) {
  const api = useCostApi();
  const lagDays = useLagDays();
  const dimensionsQuery = useQuery(() => api.getDimensions(), []);

  const [state, setState] = useState<TrendsState>(() => ({
    selectedDimensionId: null,
    direction: 'all',
    dateRange: getDefaultDateRange(lagDays),
    granularity: 'daily' satisfies Granularity,
    deltaThreshold: 0,
    percentThreshold: 0,
    logScale: 10,
  }));

  const dimensions: Dimension[] =
    dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];

  const gate = useMemo(
    () => rollupStatus === undefined
      ? { blocked: false, selectedMonths: [], pendingMonths: [] }
      : rollupGate(rollupStatus, rollupEverReady ?? false, state.dateRange),
    [rollupStatus, rollupEverReady, state.dateRange],
  );

  const firstDimId = dimensions.length > 0 && dimensions[0] !== undefined
    ? getDimensionId(dimensions[0])
    : null;
  const activeDimensionId = state.selectedDimensionId ?? firstDimId;

  const trendsFirstRef = useRef(true);
  useEffect(() => {
    if (trendsFirstRef.current) {
      trendsFirstRef.current = false;
      return;
    }
    api.cancelPendingQueries().catch(() => undefined);
  }, [state.dateRange.start, state.dateRange.end, state.granularity, api]);

  const trendsQuery = useQuery(
    () => {
      if (activeDimensionId === null) return Promise.resolve(null);
      return api.queryTrends({
        groupBy: activeDimensionId,
        dateRange: state.dateRange,
        filters: {},
        deltaThreshold: asDollars(state.deltaThreshold),
        percentThreshold: state.percentThreshold,
        origin: `trends:${String(activeDimensionId)}`,
      });
    },
    [activeDimensionId, state.dateRange.start, state.dateRange.end, state.deltaThreshold, state.percentThreshold, api],
  );

  const trendData: TrendResult | null =
    trendsQuery.status === 'success' ? trendsQuery.data : null;

  let rows: readonly TrendRow[] = [];
  let totalIncrease = 0;
  let totalSavings = 0;
  if (trendData !== null) {
    // The backend partitions raw SQL rows into increases / savings by sign
    // and then merges within each bucket by friendly entity name. For the
    // account dim, two account_ids can resolve to the same name with opposing
    // deltas — leaving the same entity in *both* buckets and hiding its true
    // net direction. Net the buckets here so each entity surfaces once with
    // the right sign.
    const merged = new Map<string, { currentCost: number; previousCost: number; delta: number }>();
    for (const r of [...trendData.increases, ...trendData.savings]) {
      const existing = merged.get(r.entity);
      if (existing === undefined) {
        merged.set(r.entity, { currentCost: r.currentCost, previousCost: r.previousCost, delta: r.delta });
      } else {
        existing.currentCost += r.currentCost;
        existing.previousCost += r.previousCost;
        existing.delta += r.delta;
      }
    }
    const allRows: TrendRow[] = [...merged.entries()].map(([entity, d]) => ({
      entity: asEntityRef(entity),
      currentCost: asDollars(d.currentCost),
      previousCost: asDollars(d.previousCost),
      delta: asDollars(d.delta),
      percentChange: d.previousCost === 0
        ? (d.currentCost === 0 ? 0 : 100)
        : (d.delta / d.previousCost) * 100,
    }));
    for (const r of allRows) {
      if (r.delta > 0) totalIncrease += r.delta;
      else totalSavings += Math.abs(r.delta);
    }
    let pool: TrendRow[];
    if (state.direction === 'increases') pool = allRows.filter(r => r.delta > 0);
    else if (state.direction === 'savings') pool = allRows.filter(r => r.delta < 0);
    else pool = allRows;
    pool.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    rows = pool;
  }

  let totalLabel = '';
  if (trendData !== null) {
    if (state.direction === 'increases') {
      totalLabel = `+${formatDollars(asDollars(totalIncrease))} total increase`;
    } else if (state.direction === 'savings') {
      totalLabel = `-${formatDollars(asDollars(totalSavings))} total savings`;
    } else {
      totalLabel = `+${formatDollars(asDollars(totalIncrease))} increase · -${formatDollars(asDollars(totalSavings))} savings`;
    }
  }

  function handleEntityClick(entity: EntityRef) {
    if (onEntityClickProp !== undefined && activeDimensionId !== null) {
      onEntityClickProp(entity, activeDimensionId);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <p className="text-base font-medium text-text-secondary">Period-over-period comparison</p>
        <DateRangePicker
          value={state.dateRange}
          granularity={state.granularity}
          onChange={(range, g) => { setState(s => ({ ...s, dateRange: range, granularity: g })); }}
          hideHourly
          lagDays={lagDays}
        />
      </div>

      {gate.blocked && rollupStatus !== undefined ? (
        <RollupBuildingOverlay status={rollupStatus} pendingMonths={gate.pendingMonths} />
      ) : (
      <>
      {dimensions.length > 0 && (
        <div className="flex flex-wrap items-center gap-4">
          <DimensionSelector
            dimensions={dimensions}
            selected={activeDimensionId ?? ''}
            onSelect={(id) => { setState((p) => ({ ...p, selectedDimensionId: asDimensionId(id) })); }}
          />

          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-1">
            {DIRECTION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => { setState((p) => ({ ...p, direction: opt.value })); }}
                className={[
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  state.direction === opt.value
                    ? 'bg-accent text-bg-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {opt.label}
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
            <div className="flex items-center gap-1.5">
              <span>Scale</span>
              <div className="flex items-center gap-0.5 rounded border border-border p-0.5">
                {SCALE_OPTIONS.map(o => (
                  <button
                    key={String(o.value)}
                    type="button"
                    onClick={() => { setState(p => ({ ...p, logScale: o.value })); }}
                    className={[
                      'rounded px-2 py-0.5 text-[11px]',
                      state.logScale === o.value ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary',
                    ].join(' ')}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {trendData !== null && (
        <div className="text-sm font-medium text-text-secondary">
          {String(rows.length)} items · {totalLabel}
        </div>
      )}

      {trendsQuery.status === 'loading' && (
        <div className="flex-1">
          <CoinRainLoader height={500} count={10} />
        </div>
      )}
      {trendsQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {trendsQuery.error.message}
        </div>
      )}

      {rows.length > 0 && (
        <BubbleChart data={rows} logScale={state.logScale} onEntityClick={handleEntityClick} />
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
          No {state.direction === 'all' ? 'changes' : state.direction} above thresholds
        </div>
      )}
      </>
      )}
    </div>
  );
}
