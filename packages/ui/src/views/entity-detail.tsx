import { useState } from 'react';
import type {
  CostResult,
  DailyCostsResult,
  Dimension,
  DimensionId,
  EntityDetailResult,
  FilterMap,
} from '@costgoblin/core/browser';
import { asDimensionId, asEntityRef, asTagValue } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars, formatPercent } from '../components/format.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { StackedBarChart } from '../components/stacked-bar-chart.js';
import type { BarDay, HistogramTab } from '../components/stacked-bar-chart.js';
import { getDimensionId, getDimensionLabel, isEnvironmentDimension, isOwnerDimension, isProductDimension } from '../lib/dimensions.js';

interface EntityDetailProps {
  entity: string;
  dimension: string;
  onBack: () => void;
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

function buildEntityCsv(data: EntityDetailResult): string {
  const lines: string[] = [
    `Entity,${String(data.entity)}`,
    `Total Cost,${String(data.totalCost)}`,
    `Percent Change,${String(data.percentChange)}`,
    '',
    'Date,Cost',
    ...data.dailyCosts.map((d) => `${String(d.date)},${String(d.cost)}`),
    '',
    'Account,Cost,Percentage',
    ...data.byAccount.map((r) => `${r.name},${String(r.cost)},${String(r.percentage)}`),
    '',
    'Service,Cost,Percentage',
    ...data.byService.map((r) => `${r.name},${String(r.cost)},${String(r.percentage)}`),
  ];
  return lines.join('\n');
}

function handleCsvExport(data: EntityDetailResult, entity: string) {
  const csv = buildEntityCsv(data);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `costgoblin-${entity}-detail.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function EntityDetail({ entity, dimension, onBack }: Readonly<EntityDetailProps>) {
  const api = useCostApi();
  const lagDays = useLagDays();
  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [histogramTab, setHistogramTab] = useState<HistogramTab>('service');
  const [histogramExpanded, setHistogramExpanded] = useState(false);
  const [pie1DimId, setPie1DimId] = useState<DimensionId | null>(null);
  const [pie2DimId, setPie2DimId] = useState<DimensionId | null>(null);
  const [pie3DimId, setPie3DimId] = useState<DimensionId | null>(null);

  const dateRangeKey = `${dateRange.start}_${dateRange.end}`;
  const entityFilter: FilterMap = { [asDimensionId(dimension)]: asTagValue(entity) };
  const filterKey = JSON.stringify(entityFilter);

  // Entity detail summary (total, previous, percent change)
  const detailQuery = useQuery(
    () => api.queryEntityDetail({
      entity: asEntityRef(entity),
      dimension: asDimensionId(dimension),
      dateRange,
      filters: {},
      granularity,
    }),
    [entity, dimension, dateRangeKey, granularity, api],
  );
  const data: EntityDetailResult | null =
    detailQuery.status === 'success' ? detailQuery.data : null;

  // Dimensions for pie selectors
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

  const serviceDimId = asDimensionId('service');
  const accountDimId = asDimensionId('account');
  const ownerDim = rawDimensions.find(isOwnerDimension);
  const productDim = rawDimensions.find(isProductDimension);
  const regionDimId = asDimensionId('region');

  const effectivePie1 = pie1DimId ?? accountDimId;
  const effectivePie2 = pie2DimId ?? (productDim !== undefined ? getDimensionId(productDim) : regionDimId);
  const effectivePie3 = pie3DimId ?? serviceDimId;

  // Pie queries — same as overview but scoped to this entity via filter
  const pie1Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie1, dateRange, filters: entityFilter, granularity }),
    [effectivePie1, dateRangeKey, filterKey, granularity, api],
  );
  const pie1Slices = costRowsToSlices(pie1Query.status === 'success' ? pie1Query.data : null);

  const pie2Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie2, dateRange, filters: entityFilter, granularity }),
    [effectivePie2, dateRangeKey, filterKey, granularity, api],
  );
  const pie2Slices = costRowsToSlices(pie2Query.status === 'success' ? pie2Query.data : null);

  const pie3Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie3, dateRange, filters: entityFilter, granularity }),
    [effectivePie3, dateRangeKey, filterKey, granularity, api],
  );
  const pie3Slices = costRowsToSlices(pie3Query.status === 'success' ? pie3Query.data : null);

  // Histogram — reuse StackedBarChart with queryDailyCosts
  const histogramDimId = histogramTab === 'owner' && ownerDim !== undefined
    ? getDimensionId(ownerDim)
    : histogramTab === 'product' && productDim !== undefined
      ? getDimensionId(productDim)
      : serviceDimId;

  const dailyQuery = useQuery(
    () => api.queryDailyCosts({ groupBy: histogramDimId, dateRange, filters: entityFilter, granularity }),
    [histogramDimId, dateRangeKey, filterKey, granularity, api],
  );
  const barDays = dailyCostsToBarDays(dailyQuery.status === 'success' ? dailyQuery.data : null);

  const totalCost = data !== null ? data.totalCost : 0;
  const isIncrease = data !== null && data.percentChange > 0;
  const isDecrease = data !== null && data.percentChange < 0;

  const isLoading = detailQuery.status === 'loading';

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            ← Back
          </button>
          <div>
            <p className="text-xs uppercase tracking-wider text-text-muted">{dimension}</p>
            <h2 className="text-xl font-semibold text-text-primary">{entity}</h2>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <DateRangePicker value={dateRange} granularity={granularity} onChange={(range, g) => { setDateRange(range); setGranularity(g); }} lagDays={lagDays} />
          {data !== null && (
            <button
              type="button"
              onClick={() => { handleCsvExport(data, entity); }}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              Export CSV
            </button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="text-sm text-text-secondary">Loading...</div>
      )}
      {detailQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {detailQuery.error.message}
        </div>
      )}

      {data !== null && (
        <>
          {/* Row 1: Summary + histogram (same layout as overview) */}
          <div className={`grid gap-4 ${histogramExpanded ? 'grid-cols-1' : 'grid-cols-3'}`}>
            {!histogramExpanded && (
              <div className="flex flex-col gap-4">
                <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
                  <p className="text-xs uppercase tracking-wider text-text-muted">Total</p>
                  <p className="mt-1 text-3xl font-bold tabular-nums text-text-primary">
                    {formatDollars(totalCost)}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
                  <p className="text-xs uppercase tracking-wider text-text-muted">vs Previous Period</p>
                  {(() => {
                    const changeColor = isIncrease ? 'text-negative' : isDecrease ? 'text-positive' : 'text-text-secondary';
                    return (
                      <p className={`mt-1 text-2xl font-bold tabular-nums ${changeColor}`}>
                        {formatPercent(data.percentChange)}
                      </p>
                    );
                  })()}
                  <p className="mt-0.5 text-xs text-text-muted">
                    Previous: {formatDollars(data.previousCost)}
                  </p>
                </div>
              </div>
            )}

            <div className={histogramExpanded ? '' : 'col-span-2'}>
              <StackedBarChart
                days={barDays}
                tab={histogramTab}
                onTabChange={setHistogramTab}
                expanded={histogramExpanded}
                onExpandToggle={() => { setHistogramExpanded(prev => !prev); }}
                title={granularity === 'hourly' ? 'Hourly Costs' : 'Daily Costs'}
                loading={dailyQuery.status === 'loading'}
              />
            </div>
          </div>

          {/* Row 2: Three pie charts with dimension selectors (same as overview) */}
          <div className="flex gap-4">
            {([
              { dimId: effectivePie1, setDim: setPie1DimId, slices: pie1Slices },
              { dimId: effectivePie2, setDim: setPie2DimId, slices: pie2Slices },
              { dimId: effectivePie3, setDim: setPie3DimId, slices: pie3Slices },
            ] as const).map(({ dimId, setDim, slices }) => (
              <div key={dimId} className="min-w-0 flex-1">
                <PieChart
                  data={slices}
                  title={(() => {
                    const dim = rawDimensions.find(d => getDimensionId(d) === dimId);
                    return dim !== undefined ? getDimensionLabel(dim) : dimId;
                  })()}
                  subtitle="Click to filter"
                  dimensions={dimensions}
                  activeDimensionId={dimId}
                  onDimensionChange={(newDimId) => { setDim(asDimensionId(newDimId)); }}
                />
              </div>
            ))}
          </div>

          {/* Row 3: Breakdown table */}
          <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
            <div className="border-b border-border px-5 py-3">
              <h3 className="text-sm font-medium text-text-secondary">Breakdown</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-text-secondary">
                    <th className="px-5 pb-2 pt-3 font-medium">Service</th>
                    <th className="px-5 pb-2 pt-3 text-right font-medium">Cost</th>
                    <th className="px-5 pb-2 pt-3 text-right font-medium">%</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byService.map(s => (
                    <tr key={s.name} className="border-b border-border-subtle hover:bg-bg-tertiary/20 transition-colors">
                      <td className="px-5 py-2 text-text-primary">{s.name}</td>
                      <td className="px-5 py-2 text-right tabular-nums text-text-primary font-medium">
                        {formatDollars(s.cost)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-text-secondary">
                        {s.percentage.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
