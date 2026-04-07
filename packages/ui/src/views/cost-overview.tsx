import type {
  CostResult,
  EntityDetailResult,
  DimensionId,
  Dimension,
  FilterMap,
} from '@costgoblin/core/browser';
import { asDimensionId, asEntityRef, asTagValue } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import {
  useCostFocusReducer,
  CostFocusProvider,
  CostFocusDispatchProvider,
  useCostFocus,
  useCostFocusDispatch,
} from '../hooks/use-cost-focus.js';
import type { HistogramTab } from '../components/stacked-bar-chart.js';
import { getDimensionId, isProductDimension, isEnvironmentDimension } from '../lib/dimensions.js';
import { EnvironmentBar } from '../components/environment-bar.js';
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

function entityDetailToBarDays(data: EntityDetailResult | null, groupBy: HistogramTab): BarDay[] {
  if (data === null) return [];
  return data.dailyCosts.map(d => ({
    date: d.date,
    total: d.cost,
    breakdown: groupBy === 'service' ? { ...d.breakdown } : { ...d.breakdownByAccount },
  }));
}

function getEnvDimensionId(dimensions: Dimension[]): DimensionId | null {
  const envDim = dimensions.find(isEnvironmentDimension);
  return envDim !== undefined ? getDimensionId(envDim) : null;
}

function getProductDimensionId(dimensions: Dimension[]): DimensionId | null {
  const dim = dimensions.find(isProductDimension);
  return dim !== undefined ? getDimensionId(dim) : null;
}

function OverviewInner({ onEntityClick: onEntityClickProp }: CostOverviewProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [histogramTab, setHistogramTab] = useState<HistogramTab>('owner');

  const dimensionsQuery = useQuery(() => api.getDimensions(), []);
  const dimensions: Dimension[] = dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];

  const envDimId = getEnvDimensionId(dimensions);
  const productDimId = getProductDimensionId(dimensions);
  const serviceDimId = asDimensionId('service');
  const accountDimId = asDimensionId('account');

  const baseFilters: FilterMap = focus.environment !== null && envDimId !== null
    ? { [envDimId]: asTagValue(focus.environment) }
    : {};

  const serviceFilters: FilterMap = focus.serviceDrill.depth !== 'none'
    ? { ...baseFilters, [serviceDimId]: asTagValue(focus.serviceDrill.service) }
    : baseFilters;

  const dateRangeKey = `${dateRange.start}_${dateRange.end}`;
  const filterKey = JSON.stringify(baseFilters);
  const serviceFilterKey = JSON.stringify(serviceFilters);

  // Environment costs query (unfiltered, for the env bar)
  const envCostsQuery = useQuery(
    () => {
      if (envDimId === null) return Promise.resolve(null);
      return api.queryCosts({ groupBy: envDimId, dateRange, filters: {} });
    },
    [envDimId, dateRangeKey, api],
  );

  const envBarData = envCostsQuery.status === 'success' && envCostsQuery.data !== null
    ? envCostsQuery.data.rows.map(r => ({ name: r.entity, cost: r.totalCost }))
    : [];

  // Accounts pie
  const accountsQuery = useQuery(
    () => api.queryCosts({ groupBy: accountDimId, dateRange, filters: serviceFilters }),
    [dateRangeKey, serviceFilterKey, api],
  );
  const accountSlices = costRowsToSlices(accountsQuery.status === 'success' ? accountsQuery.data : null);

  // Products/Systems pie
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

  // Summary — use total from accounts query as the primary
  const totalCost = accountsQuery.status === 'success'
    ? accountsQuery.data.totalCost
    : 0;

  // Histogram — reuse the entity detail for the first owner entity (aggregate)
  // For now, use the owner-level query data to build a simple daily chart
  // Daily histogram — use entity detail from first account to get daily breakdown
  const firstEntity = accountsQuery.status === 'success' && accountsQuery.data.rows[0] !== undefined
    ? accountsQuery.data.rows[0].entity
    : null;

  const dailyQuery = useQuery(
    () => {
      if (firstEntity === null) return Promise.resolve(null);
      return api.queryEntityDetail({
        entity: asEntityRef(firstEntity),
        dimension: accountDimId,
        dateRange,
        filters: baseFilters,
      });
    },
    [firstEntity, dateRangeKey, filterKey, api],
  );

  const barDays = entityDetailToBarDays(
    dailyQuery.status === 'success' ? dailyQuery.data : null,
    histogramTab === 'service' ? 'service' : 'owner',
  );

  // Service drill-down click handler
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

      {/* Environment filter bar */}
      {envBarData.length > 0 && (
        <EnvironmentBar
          environments={envBarData}
          selected={focus.environment}
          onSelect={(env) => { dispatch({ type: 'SET_ENVIRONMENT', env }); }}
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
          {/* Quick stats */}
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

      {/* Bottom row: 3 pie charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PieChart
          data={accountSlices}
          title="Accounts"
          subtitle="Click to navigate"
          onSliceClick={handleAccountClick}
          onSliceHover={(name) => { handleHover(name, 'account'); }}
          externalHoveredName={focus.hoveredDimension === 'account' ? focus.hoveredEntity : null}
        />
        <PieChart
          data={productSlices}
          title="Products"
          subtitle="Click to navigate"
          onSliceClick={handleProductClick}
          onSliceHover={(name) => { handleHover(name, 'product'); }}
          externalHoveredName={focus.hoveredDimension === 'product' ? focus.hoveredEntity : null}
        />
        <PieChart
          data={serviceSlices}
          title={servicePieTitle}
          subtitle={servicePieSubtitle}
          onSliceClick={handleServiceClick}
          onSliceHover={(name) => { handleHover(name, 'service'); }}
          externalHoveredName={focus.hoveredDimension === 'service' ? focus.hoveredEntity : null}
        />
      </div>
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
