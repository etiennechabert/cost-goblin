import { useMemo, useState } from 'react';
import { useCostWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { TopNBar } from '../components/top-n-bar-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { Anomaly, AnomalyResult, AnomalySeverity, CostResult, DimensionId } from '@costgoblin/core/browser';
import type { AnomalyEntry } from '../components/top-n-bar-chart.js';
import { ANOMALY_LOOKBACK_DAYS, ANOMALY_STDDEV_THRESHOLD } from '../lib/anomaly-constants.js';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters, hasSufficientCoverage } from './widget.js';
import { GroupByTitle } from '../components/group-by-title.js';

function rowsToBars(data: CostResult | null): TopNBar[] {
  if (data === null) return [];
  const total = data.totalCost;
  return data.rows.map(r => ({
    name: r.entity,
    cost: r.totalCost,
    percentage: total > 0 ? (r.totalCost / total) * 100 : 0,
  }));
}

function buildPreviousCostMap(data: CostResult | null): ReadonlyMap<string, number> {
  if (data === null) return new Map();
  return new Map(data.rows.map(r => [r.entity, r.totalCost]));
}

const SEVERITY_RANK: Record<AnomalySeverity, number> = { low: 0, medium: 1, high: 2 };

/** Group anomalies by entity, keeping a count and the most severe anomaly as
 *  the badge's primary. Ties on severity are broken by the higher deviation. */
function buildAnomaliesMap(data: AnomalyResult | null): ReadonlyMap<string, AnomalyEntry> {
  if (data === null || data.anomalies.length === 0) return new Map();
  const grouped = new Map<string, { count: number; primary: Anomaly }>();
  for (const anomaly of data.anomalies) {
    const existing = grouped.get(anomaly.entity);
    if (existing === undefined) {
      grouped.set(anomaly.entity, { count: 1, primary: anomaly });
      continue;
    }
    const incomingRank = SEVERITY_RANK[anomaly.severity];
    const currentRank = SEVERITY_RANK[existing.primary.severity];
    const promote =
      incomingRank > currentRank ||
      (incomingRank === currentRank && anomaly.deviation > existing.primary.deviation);
    grouped.set(anomaly.entity, {
      count: existing.count + 1,
      primary: promote ? anomaly : existing.primary,
    });
  }
  return grouped;
}

export function TopNBarWidget({
  spec,
  dateRange,
  previousDateRange,
  compareEnabled,
  granularity,
  globalFilters,
  dimensions,
  anomaliesState,
  onAnomalyDismissed,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'topNBar' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);

  const { query, activeGroupBy, costResult } = useCostWidgetQuery({
    specGroupBy: effectiveGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
  });

  const prevQuery = useQuery<CostResult | null>(
    () => compareEnabled && effectiveGroupBy !== undefined
      ? api.queryCosts({ groupBy: effectiveGroupBy, dateRange: previousDateRange, filters, granularity })
      : Promise.resolve(null),
    [compareEnabled, effectiveGroupBy, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, fk, granularity, api],
  );

  const bars = useMemo(
    () => rowsToBars(costResult),
    [costResult],
  );

  const prevHasCoverage = prevQuery.status === 'success' && prevQuery.data !== null && hasSufficientCoverage(prevQuery.data, previousDateRange);
  const previousCosts = useMemo(
    () => buildPreviousCostMap(prevHasCoverage ? prevQuery.data : null),
    [prevHasCoverage, prevQuery],
  );

  const anomaliesByEntity = useMemo(
    () => buildAnomaliesMap(anomaliesState.status === 'success' ? anomaliesState.data : null),
    [anomaliesState],
  );

  if (spec.type !== 'topNBar' || effectiveGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  return (
    <TopNBarChart
      data={bars}
      title={spec.title ?? <GroupByTitle dimensions={dimensions} currentGroupBy={activeGroupBy} onGroupByChange={setGroupByOverride} label={label} />}
      subtitle="Click to filter"
      topN={spec.topN ?? 12}
      onBarClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
      onBarHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: activeGroupBy }); }}
      externalHoveredName={focus.hoveredDimension === activeGroupBy ? focus.hoveredEntity : null}
      previousCosts={compareEnabled ? previousCosts : undefined}
      anomaliesByEntity={anomaliesByEntity.size > 0 ? anomaliesByEntity : undefined}
      anomalyLookbackDays={ANOMALY_LOOKBACK_DAYS}
      anomalyStddevThreshold={ANOMALY_STDDEV_THRESHOLD}
      onAnomalyDismissed={onAnomalyDismissed}
    />
  );
}
