import type {
  CostResult,
  DailyCostsResult,
  DimensionId,
  Dimension,
  FilterMap,
} from '@costgoblin/core/browser';
import { asDimensionId, asTagValue } from '@costgoblin/core/browser';
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
import { getDimensionId, isProductDimension, isEnvironmentDimension, isOwnerDimension } from '../lib/dimensions.js';
import { FilterBar } from '../components/filter-bar.js';
import { FilterActiveBanner } from '../components/filter-active-banner.js';
import { SummaryCard } from '../components/summary-card.js';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { StackedBarChart } from '../components/stacked-bar-chart.js';
import type { BarDay } from '../components/stacked-bar-chart.js';
import { CsvExport } from '../components/csv-export.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange } from '../components/date-range-picker.js';
import { formatDollars } from '../components/format.js';
import { useState } from 'react';

interface CostOverviewProps {
  onEntityClick?: (entity: string, dimension: string) => void;
}

function costRowsToSlices(data: CostResult | null): PieSlice[] {
  if (data === null) return [];
  const total = data.totalCost;
  return data.rows.map(r => ({
    name: r.entity,
    cost: r.totalCost,
    percentage: total > 0 ? (r.totalCost / total) * 100 : 0,
  }));
}

function dailyCostsToBarDays(data: DailyCostsResult | null): BarDay[] {
  if (data === null) return [];
  return data.days.map(d => ({
    date: d.date,
    total: d.total,
    breakdown: { ...d.breakdown },
  }));
}

function getProductDimensionId(dimensions: Dimension[]): DimensionId | null {
  const dim = dimensions.find(isProductDimension);
  return dim !== undefined ? getDimensionId(dim) : null;
}

function getOwnerDimensionId(dimensions: Dimension[]): DimensionId | null {
  const dim = dimensions.find(isOwnerDimension);
  return dim !== undefined ? getDimensionId(dim) : null;
}

function OverviewInner({ onEntityClick: onEntityClickProp }: CostOverviewProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [histogramTab, setHistogramTab] = useState<HistogramTab>('owner');
  const [filters, setFilters] = useState<FilterMap>({});

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

  const baseFilters: FilterMap = filters;

  const serviceFilters: FilterMap = focus.serviceDrill.depth !== 'none'
    ? { ...baseFilters, [serviceDimId]: asTagValue(focus.serviceDrill.service) }
    : baseFilters;

  const dateRangeKey = `${dateRange.start}_${dateRange.end}`;
  const filterKey = JSON.stringify(baseFilters);
  const serviceFilterKey = JSON.stringify(serviceFilters);

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

  // Accounts pie
  const accountsQuery = useQuery(
    () => api.queryCosts({ groupBy: accountDimId, dateRange, filters: serviceFilters }),
    [dateRangeKey, serviceFilterKey, api],
  );
  const accountSlices = costRowsToSlices(accountsQuery.status === 'success' ? accountsQuery.data : null);

  // Products pie
  const productsQuery = useQuery(
    () => {
      if (productDimId === null) return Promise.resolve(null);
      return api.queryCosts({ groupBy: productDimId, dateRange, filters: serviceFilters });
    },
    [productDimId, dateRangeKey, serviceFilterKey, api],
  );
  const productSlices = costRowsToSlices(productsQuery.status === 'success' ? productsQuery.data : null);

  // Services pie (or service_family when drilled)
  const servicesGroupBy = focus.serviceDrill.depth === 'service'
    ? asDimensionId('service_family')
    : serviceDimId;
  const servicesQuery = useQuery(
    () => api.queryCosts({
      groupBy: servicesGroupBy,
      dateRange,
      filters: focus.serviceDrill.depth === 'service'
        ? { ...baseFilters, [serviceDimId]: asTagValue(focus.serviceDrill.service) }
        : baseFilters,
    }),
    [servicesGroupBy, dateRangeKey, filterKey, focus.serviceDrill, api],
  );
  const serviceSlices = costRowsToSlices(servicesQuery.status === 'success' ? servicesQuery.data : null);

  // Summary
  const totalCost = accountsQuery.status === 'success'
    ? accountsQuery.data.totalCost
    : 0;

  // Daily histogram via queryDailyCosts
  const histogramDimId = histogramTab === 'owner' ? ownerDimId
    : histogramTab === 'product' ? productDimId
    : serviceDimId;

  const dailyQuery = useQuery(
    () => {
      if (histogramDimId === null) return Promise.resolve(null);
      return api.queryDailyCosts({ groupBy: histogramDimId, dateRange, filters: baseFilters });
    },
    [histogramDimId, dateRangeKey, filterKey, api],
  );

  const barDays = dailyCostsToBarDays(dailyQuery.status === 'success' ? dailyQuery.data : null);

  // Handlers
  function handleServiceClick(name: string) {
    if (focus.serviceDrill.depth === 'none') {
      dispatch({ type: 'DRILL_SERVICE', service: name });
    } else if (focus.serviceDrill.depth === 'service') {
      dispatch({ type: 'DRILL_SERVICE_FAMILY', family: name });
    } else {
      dispatch({ type: 'DRILL_UNWIND' });
    }
  }

  function handleAccountClick(name: string) {
    onEntityClickProp?.(name, accountDimId);
  }

  function handleProductClick(name: string) {
    if (productDimId !== null) {
      onEntityClickProp?.(name, productDimId);
    }
  }

  function handleHover(entity: string | null, dimension: string | null) {
    dispatch({ type: 'HOVER', entity, dimension });
  }

  function handleExpandToggle(pie: ExpandedPie) {
    dispatch({ type: 'TOGGLE_EXPAND', pie });
  }

  const servicePieTitle = focus.serviceDrill.depth === 'none'
    ? 'AWS Services'
    : focus.serviceDrill.depth === 'service'
      ? focus.serviceDrill.service
      : `${focus.serviceDrill.service} → ${focus.serviceDrill.family}`;

  const servicePieSubtitle = focus.serviceDrill.depth === 'none'
    ? 'Click to drill down'
    : focus.serviceDrill.depth === 'service'
      ? 'Click to drill deeper'
      : 'Click to go back';

  const isLoading = dimensionsQuery.status === 'loading'
    || accountsQuery.status === 'loading'
    || servicesQuery.status === 'loading';

  // Breakdown table data — use the active account query's rows with service breakdown
  const breakdownRows = accountsQuery.status === 'success'
    ? accountsQuery.data.rows
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Cost Overview</h2>
          <p className="text-sm text-text-secondary mt-0.5">Cloud spending visibility</p>
        </div>
        <div className="flex items-center gap-3">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          {accountsQuery.status === 'success' && (
            <CsvExport rows={accountsQuery.data.rows} topServices={accountsQuery.data.topServices} />
          )}
        </div>
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
      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-4">
          <SummaryCard
            totalCost={totalCost}
            dateRange={dateRange}
          />
          <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
            <p className="text-xs uppercase tracking-wider text-text-muted">Top entities</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {accountSlices.slice(0, 5).map(s => (
                <div key={s.name} className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary truncate mr-2">{s.name}</span>
                  <span className="text-text-primary tabular-nums font-medium">{formatDollars(s.cost)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="col-span-2">
          <StackedBarChart
            days={barDays}
            highlightedGroup={focus.hoveredEntity}
            tab={histogramTab}
            onTabChange={setHistogramTab}
          />
        </div>
      </div>

      {/* Bottom row: 3 pie charts with expand/collapse */}
      <div className="flex gap-4">
        <div className={focus.expandedPie === null || focus.expandedPie === 'accounts' ? 'flex-1' : ''}>
          <PieChart
            data={accountSlices}
            title="Accounts"
            subtitle="Click to navigate"
            onSliceClick={handleAccountClick}
            onSliceHover={(name) => { handleHover(name, 'account'); }}
            externalHoveredName={focus.hoveredDimension === 'account' ? focus.hoveredEntity : null}
            collapsed={focus.expandedPie !== null && focus.expandedPie !== 'accounts'}
            onExpandToggle={() => { handleExpandToggle('accounts'); }}
          />
        </div>
        <div className={focus.expandedPie === null || focus.expandedPie === 'products' ? 'flex-1' : ''}>
          <PieChart
            data={productSlices}
            title="Products"
            subtitle="Click to navigate"
            onSliceClick={handleProductClick}
            onSliceHover={(name) => { handleHover(name, 'product'); }}
            externalHoveredName={focus.hoveredDimension === 'product' ? focus.hoveredEntity : null}
            collapsed={focus.expandedPie !== null && focus.expandedPie !== 'products'}
            onExpandToggle={() => { handleExpandToggle('products'); }}
          />
        </div>
        <div className={focus.expandedPie === null || focus.expandedPie === 'services' ? 'flex-1' : ''}>
          <PieChart
            data={serviceSlices}
            title={servicePieTitle}
            subtitle={servicePieSubtitle}
            onSliceClick={handleServiceClick}
            onSliceHover={(name) => { handleHover(name, 'service'); }}
            externalHoveredName={focus.hoveredDimension === 'service' ? focus.hoveredEntity : null}
            collapsed={focus.expandedPie !== null && focus.expandedPie !== 'services'}
            onExpandToggle={() => { handleExpandToggle('services'); }}
          />
        </div>
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

export function CostOverview(props: CostOverviewProps) {
  const [state, dispatch] = useCostFocusReducer();

  return (
    <CostFocusProvider value={state}>
      <CostFocusDispatchProvider value={dispatch}>
        <OverviewInner {...props} />
      </CostFocusDispatchProvider>
    </CostFocusProvider>
  );
}
