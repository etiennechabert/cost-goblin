import type {
  CostResult,
  DailyCostsResult,
  DimensionId,
  Dimension,
  FilterMap,
} from '@costgoblin/core/browser';
import { asDimensionId, asDateString, asTagValue } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import {
  useCostFocusReducer,
  CostFocusProvider,
  CostFocusDispatchProvider,
  useCostFocus,
  useCostFocusDispatch,
} from '../hooks/use-cost-focus.js';
import type { ExpandedPie } from '../hooks/use-cost-focus.js';
import type { HistogramTab } from '../components/stacked-bar-chart.js';
import { getDimensionId, getDimensionLabel, isProductDimension, isEnvironmentDimension, isOwnerDimension } from '../lib/dimensions.js';
import { FilterBar } from '../components/filter-bar.js';
import { FilterActiveBanner } from '../components/filter-active-banner.js';
import { SummaryCard } from '../components/summary-card.js';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { StackedBarChart } from '../components/stacked-bar-chart.js';
import type { BarDay } from '../components/stacked-bar-chart.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';
import { formatDollars } from '../components/format.js';
import { useState } from 'react';

function costRowsToSlices(data: CostResult | null): PieSlice[] {
  if (data === null) return [];
  const total = data.totalCost;
  return data.rows.map(r => ({
    name: r.entity,
    cost: r.totalCost,
    percentage: total > 0 ? (r.totalCost / total) * 100 : 0,
  }));
}

function getISOWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function aggregateToWeekly(days: BarDay[]): BarDay[] {
  const weeks = new Map<string, { total: number; breakdown: Record<string, number> }>();
  for (const day of days) {
    const weekStart = getISOWeekStart(day.date);
    let week = weeks.get(weekStart);
    if (week === undefined) {
      week = { total: 0, breakdown: {} };
      weeks.set(weekStart, week);
    }
    week.total += day.total;
    for (const [key, val] of Object.entries(day.breakdown)) {
      week.breakdown[key] = (week.breakdown[key] ?? 0) + val;
    }
  }
  return [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, data]) => ({ date, total: data.total, breakdown: data.breakdown }));
}

function dailyCostsToBarDays(data: DailyCostsResult | null, useWeekly: boolean): BarDay[] {
  if (data === null) return [];
  const daily = data.days.map(d => ({
    date: d.date,
    total: d.total,
    breakdown: { ...d.breakdown },
  }));
  return useWeekly ? aggregateToWeekly(daily) : daily;
}

function getProductDimensionId(dimensions: Dimension[]): DimensionId | null {
  const dim = dimensions.find(isProductDimension);
  return dim !== undefined ? getDimensionId(dim) : null;
}

function getOwnerDimensionId(dimensions: Dimension[]): DimensionId | null {
  const dim = dimensions.find(isOwnerDimension);
  return dim !== undefined ? getDimensionId(dim) : null;
}

function OverviewInner() {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [histogramTab, setHistogramTab] = useState<HistogramTab>('service');
  const [histogramExpanded, setHistogramExpanded] = useState(false);
  const [filters, setFilters] = useState<FilterMap>({});
  const [pie1DimId, setPie1DimId] = useState<DimensionId | null>(null);
  const [pie2DimId, setPie2DimId] = useState<DimensionId | null>(null);
  const [pie3DimId, setPie3DimId] = useState<DimensionId | null>(null);

  const dimensionsQuery = useQuery(() => api.getDimensions(), []);
  const rawDimensions: Dimension[] = dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];

  const dimensions = [...rawDimensions].sort((a, b) => {
    const priority = (d: Dimension) => {
      if (isEnvironmentDimension(d)) return 0;
      if (isOwnerDimension(d)) return 1;
      if (isProductDimension(d)) return 2;
      if (!('tagName' in d)) return 3;
      return 4;
    };
    return priority(a) - priority(b);
  });

  const ownerDimId = getOwnerDimensionId(rawDimensions);
  const productDimId = getProductDimensionId(rawDimensions);
  const serviceDimId = asDimensionId('service');
  const accountDimId = asDimensionId('account');

  // Resolve effective pie dimensions (use defaults if not yet set)
  const effectivePie1 = pie1DimId ?? accountDimId;
  const regionDimId = asDimensionId('region');
  const effectivePie2 = pie2DimId ?? (productDimId ?? regionDimId);
  const effectivePie3 = pie3DimId ?? serviceDimId;

  function getDimLabel(dimId: DimensionId): string {
    const dim = rawDimensions.find(d => getDimensionId(d) === dimId);
    return dim !== undefined ? getDimensionLabel(dim) : dimId;
  }

  const baseFilters: FilterMap = filters;

  const dateRangeKey = `${dateRange.start}_${dateRange.end}`;
  const filterKey = JSON.stringify(baseFilters);
  function handleFilterChange(newFilters: FilterMap) {
    setFilters(newFilters);
  }

  function handleGetFilterValues(dimensionId: DimensionId, currentFilters: FilterMap): Promise<{ value: string; label: string; count: number }[]> {
    const plainFilters: Record<string, string> = {};
    for (const [k, v] of Object.entries(currentFilters)) {
      if (v !== undefined) plainFilters[k] = v;
    }
    return api.getFilterValues(dimensionId, plainFilters, dateRange);
  }

  // Pie 1 query
  const pie1Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie1, dateRange, filters: baseFilters, granularity }),
    [effectivePie1, dateRangeKey, filterKey, granularity, api],
  );
  const pie1Slices = costRowsToSlices(pie1Query.status === 'success' ? pie1Query.data : null);

  // Pie 2 query
  const pie2Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie2, dateRange, filters: baseFilters, granularity }),
    [effectivePie2, dateRangeKey, filterKey, granularity, api],
  );
  const pie2Slices = costRowsToSlices(pie2Query.status === 'success' ? pie2Query.data : null);

  // Pie 3 query (supports service drill-down when showing services)
  const isServicePie = effectivePie3 === serviceDimId;
  const pie3GroupBy = isServicePie && focus.serviceDrill.depth === 'service'
    ? asDimensionId('service_family')
    : effectivePie3;
  const pie3Filters = isServicePie && focus.serviceDrill.depth === 'service'
    ? { ...baseFilters, [serviceDimId]: asTagValue(focus.serviceDrill.service) }
    : baseFilters;
  const pie3Query = useQuery(
    () => api.queryCosts({ groupBy: pie3GroupBy, dateRange, filters: pie3Filters, granularity }),
    [pie3GroupBy, dateRangeKey, JSON.stringify(pie3Filters), focus.serviceDrill, granularity, api],
  );
  const pie3Slices = costRowsToSlices(pie3Query.status === 'success' ? pie3Query.data : null);

  // Previous period query for comparison
  const periodDays = Math.round(
    (new Date(dateRange.end).getTime() - new Date(dateRange.start).getTime()) / (24 * 60 * 60 * 1000),
  ) + 1;
  const prevEnd = new Date(new Date(dateRange.start).getTime() - 24 * 60 * 60 * 1000);
  const prevStart = new Date(prevEnd.getTime() - (periodDays - 1) * 24 * 60 * 60 * 1000);
  const prevDateRange: DateRange = {
    start: asDateString(prevStart.toISOString().slice(0, 10)),
    end: asDateString(prevEnd.toISOString().slice(0, 10)),
  };

  const prevQuery = useQuery(
    () => api.queryCosts({ groupBy: effectivePie1, dateRange: prevDateRange, filters: baseFilters, granularity }),
    [effectivePie1, prevDateRange.start, prevDateRange.end, filterKey, granularity, api],
  );

  const totalCost = pie1Query.status === 'success'
    ? pie1Query.data.totalCost
    : 0;
  const previousCost = prevQuery.status === 'success'
    ? prevQuery.data.totalCost
    : undefined;

  // Daily histogram via queryDailyCosts
  let histogramDimId: DimensionId;
  if (histogramTab === 'owner' && ownerDimId !== null) {
    histogramDimId = ownerDimId;
  } else if (histogramTab === 'product' && productDimId !== null) {
    histogramDimId = productDimId;
  } else {
    histogramDimId = serviceDimId;
  }

  const dailyQuery = useQuery(
    () => api.queryDailyCosts({ groupBy: histogramDimId, dateRange, filters: baseFilters, granularity }),
    [histogramDimId, dateRangeKey, filterKey, granularity, api],
  );

  const useWeekly = periodDays > 90;
  const barDays = dailyCostsToBarDays(dailyQuery.status === 'success' ? dailyQuery.data : null, useWeekly);
  const histogramLoading = dailyQuery.status === 'loading';

  // Click a pie slice → set as dimension filter
  function handlePieSliceClick(dimId: DimensionId, name: string) {
    // Service pie supports drill-down
    if (dimId === serviceDimId) {
      if (focus.serviceDrill.depth === 'none') {
        dispatch({ type: 'DRILL_SERVICE', service: name });
        return;
      } else if (focus.serviceDrill.depth === 'service') {
        dispatch({ type: 'DRILL_SERVICE_FAMILY', family: name });
        return;
      } else {
        dispatch({ type: 'DRILL_UNWIND' });
        return;
      }
    }
    // All other pies: set as filter badge
    setFilters(prev => ({ ...prev, [dimId]: asTagValue(name) }));
  }

  function handleHover(entity: string | null, dimension: string | null) {
    dispatch({ type: 'HOVER', entity, dimension });
  }

  function handleExpandToggle(pie: ExpandedPie) {
    dispatch({ type: 'TOGGLE_EXPAND', pie });
  }

  function getPie3Title(): string {
    if (!isServicePie) return getDimLabel(effectivePie3);
    if (focus.serviceDrill.depth === 'none') return getDimLabel(serviceDimId);
    if (focus.serviceDrill.depth === 'service') return focus.serviceDrill.service;
    return `${focus.serviceDrill.service} → ${focus.serviceDrill.family}`;
  }

  function getPie3Subtitle(): string {
    if (!isServicePie) return 'Click to filter';
    if (focus.serviceDrill.depth === 'none') return 'Click to drill down';
    if (focus.serviceDrill.depth === 'service') return 'Click to drill deeper';
    return 'Click to go back';
  }

  const isLoading = dimensionsQuery.status === 'loading'
    || pie1Query.status === 'loading'
    || pie3Query.status === 'loading';

  // Breakdown table data — use the first pie query's rows with service breakdown
  const breakdownRows = pie1Query.status === 'success'
    ? pie1Query.data.rows
      .flatMap(r =>
        Object.entries(r.serviceCosts).map(([svc, cost]) => ({
          entity: r.entity,
          service: svc,
          cost: cost,
          percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
        })),
      )
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 20)
    : [];

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Cost Overview</h2>
          <p className="text-sm text-text-secondary mt-0.5">Cloud spending visibility</p>
        </div>
        <DateRangePicker
          value={dateRange}
          granularity={granularity}
          onChange={(range, g) => { setDateRange(range); setGranularity(g); }}
        />
      </div>

      {/* Dimension filter bar */}
      {dimensions.length > 0 && (
        <FilterBar
          dimensions={dimensions}
          filters={filters}
          onFilterChange={handleFilterChange}
          getFilterValues={handleGetFilterValues}
        />
      )}

      {/* Filter active banner */}
      <FilterActiveBanner />

      {isLoading && (
        <div className="text-sm text-text-secondary">Loading...</div>
      )}

      {/* Top row: Summary + Daily histogram */}
      <div className={`grid gap-4 ${histogramExpanded ? 'grid-cols-1' : 'grid-cols-3'}`}>
        {!histogramExpanded && (
          <div className="flex flex-col h-full">
            <SummaryCard
              totalCost={totalCost}
              previousCost={previousCost}
              dateRange={dateRange}
            />
          </div>
        )}

        <div className={histogramExpanded ? '' : 'col-span-2'}>
          <StackedBarChart
            days={barDays}
            highlightedGroup={focus.hoveredEntity}
            tab={histogramTab}
            onTabChange={setHistogramTab}
            expanded={histogramExpanded}
            onExpandToggle={() => { setHistogramExpanded(prev => !prev); }}
            title={granularity === 'hourly' ? 'Hourly Costs' : useWeekly ? 'Weekly Costs' : 'Daily Costs'}
            loading={histogramLoading}
          />
        </div>
      </div>

      {/* Bottom row: 3 pie charts with expand/collapse */}
      <div className="flex gap-4">
        {([
          { dimId: effectivePie1, setDim: setPie1DimId, slices: pie1Slices, expandKey: 'accounts' satisfies ExpandedPie },
          { dimId: effectivePie2, setDim: setPie2DimId, slices: pie2Slices, expandKey: 'products' satisfies ExpandedPie },
          { dimId: effectivePie3, setDim: setPie3DimId, slices: pie3Slices, expandKey: 'services' satisfies ExpandedPie },
        ] as const).map(({ dimId, setDim, slices, expandKey }, idx) => (
          <div key={expandKey} className={`min-w-0 ${focus.expandedPie === null || focus.expandedPie === expandKey ? 'flex-1' : ''}`}>
            <PieChart
              data={slices}
              title={idx === 2 ? getPie3Title() : getDimLabel(dimId)}
              subtitle={idx === 2 ? getPie3Subtitle() : 'Click to filter'}
              onSliceClick={(name) => { handlePieSliceClick(idx === 2 && isServicePie ? serviceDimId : dimId, name); }}
              onSliceHover={(name) => { handleHover(name, dimId); }}
              externalHoveredName={focus.hoveredDimension === dimId ? focus.hoveredEntity : null}
              collapsed={focus.expandedPie !== null && focus.expandedPie !== expandKey}
              onExpandToggle={() => { handleExpandToggle(expandKey); }}
              dimensions={dimensions}
              activeDimensionId={dimId}
              onDimensionChange={(newDimId) => { setDim(asDimensionId(newDimId)); }}
            />
          </div>
        ))}
      </div>

      {/* Breakdown table */}
      {breakdownRows.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-medium text-text-secondary">Breakdown</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className="px-5 pb-2 pt-3 font-medium">Entity</th>
                  <th className="px-5 pb-2 pt-3 font-medium">Service</th>
                  <th className="px-5 pb-2 pt-3 text-right font-medium">Cost</th>
                  <th className="px-5 pb-2 pt-3 text-right font-medium">%</th>
                </tr>
              </thead>
              <tbody>
                {breakdownRows.map((r, i) => (
                  <tr key={`${r.entity}-${r.service}-${String(i)}`} className="border-b border-border-subtle hover:bg-bg-tertiary/20 transition-colors">
                    <td className="px-5 py-2 text-text-primary">{r.entity}</td>
                    <td className="px-5 py-2 text-text-secondary">{r.service}</td>
                    <td className="px-5 py-2 text-right tabular-nums text-text-primary font-medium">
                      {formatDollars(r.cost)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-text-secondary">
                      {r.percentage.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function CostOverview() {
  const [state, dispatch] = useCostFocusReducer();

  return (
    <CostFocusProvider value={state}>
      <CostFocusDispatchProvider value={dispatch}>
        <OverviewInner />
      </CostFocusDispatchProvider>
    </CostFocusProvider>
  );
}
