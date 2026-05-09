import { useMemo, useState } from 'react';
import { useCostWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { TopNBar } from '../components/top-n-bar-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult, DimensionId, AnomalyResult, AnomalySeverity, AnomalyId } from '@costgoblin/core/browser';
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

function buildAnomaliesMap(data: AnomalyResult | null): ReadonlyMap<string, {
  readonly count: number;
  readonly severity: AnomalySeverity;
  readonly anomalyId: AnomalyId;
  readonly dimensionId: DimensionId;
  readonly service: string;
  readonly detectedDate: string;
}> {
  if (data === null || data.anomalies.length === 0) return new Map();
  // Group anomalies by entity name and keep the data for the highest severity anomaly
  const grouped = new Map<string, {
    count: number;
    severity: AnomalySeverity;
    anomalyId: AnomalyId;
    dimensionId: DimensionId;
    service: string;
    detectedDate: string;
  }>();
  for (const anomaly of data.anomalies) {
    const existing = grouped.get(anomaly.entity);
    if (existing === undefined) {
      grouped.set(anomaly.entity, {
        count: 1,
        severity: anomaly.severity,
        anomalyId: anomaly.id,
        dimensionId: anomaly.dimension,
        service: anomaly.service,
        detectedDate: anomaly.detectedDate,
      });
    } else {
      // Increment count and upgrade severity if higher (keeping the higher severity anomaly's data)
      const newSeverity = upgradeSeverity(existing.severity, anomaly.severity);
      const keepNewAnomaly = newSeverity !== existing.severity && newSeverity === anomaly.severity;
      grouped.set(anomaly.entity, {
        count: existing.count + 1,
        severity: newSeverity,
        anomalyId: keepNewAnomaly ? anomaly.id : existing.anomalyId,
        dimensionId: keepNewAnomaly ? anomaly.dimension : existing.dimensionId,
        service: keepNewAnomaly ? anomaly.service : existing.service,
        detectedDate: keepNewAnomaly ? anomaly.detectedDate : existing.detectedDate,
      });
    }
  }
  return grouped;
}

function upgradeSeverity(current: AnomalySeverity, incoming: AnomalySeverity): AnomalySeverity {
  const severityOrder: readonly AnomalySeverity[] = ['low', 'medium', 'high'];
  const currentIndex = severityOrder.indexOf(current);
  const incomingIndex = severityOrder.indexOf(incoming);
  return incomingIndex > currentIndex ? incoming : current;
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
    />
  );
}
