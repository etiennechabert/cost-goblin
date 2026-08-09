import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CostResult,
  DailyCostsResult,
  Dimension,
  DimensionId,
  EntityDetailResult,
  FilterMap,
} from '@costgoblin/core/browser';
import { asDateString, asDimensionId, asEntityRef, asHourString, asTagValue } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useQuery } from '../hooks/use-query.js';
import { useHourlyConfigured } from '../hooks/use-hourly-configured.js';
import { formatDollars, formatPercent } from '../components/format.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';
import { HourlyHintBanner } from '../components/hourly-hint-banner.js';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { StackedBarChart, bucketBars } from '../components/stacked-bar-chart.js';
import type { BarDay, HistogramTab } from '../components/stacked-bar-chart.js';
import { getDimensionId, getDimensionLabel, isEnvironmentDimension, isOwnerDimension, isProductDimension, isUnitDimension } from '../lib/dimensions.js';
import { computeBucketedHourRange, computeBucketedRange, shouldAutoSwitchToHourly } from '../lib/drag-select.js';
import { BaselineMicroBar } from '../components/baseline-micro-bar.js';

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
  const hourlyConfigured = useHourlyConfigured();
  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [histogramTab, setHistogramTab] = useState<HistogramTab>('service');
  const [histogramExpanded, setHistogramExpanded] = useState(false);
  const [hourlyHint, setHourlyHint] = useState(false);
  const [pie1DimId, setPie1DimId] = useState<DimensionId | null>(null);
  const [pie2DimId, setPie2DimId] = useState<DimensionId | null>(null);
  const [pie3DimId, setPie3DimId] = useState<DimensionId | null>(null);
  const prefsLoadedRef = useRef(false);

  const dateRangeKey = `${dateRange.start}_${dateRange.end}_${String(dateRange.startHour ?? '')}_${String(dateRange.endHour ?? '')}`;
  const entityFilter: FilterMap = { [asDimensionId(dimension)]: [asTagValue(entity)] };
  const filterKey = JSON.stringify(entityFilter);

  const cancelReadyRef = useRef(false);
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    if (!cancelReadyRef.current) {
      cancelReadyRef.current = true;
      return;
    }
    api.cancelPendingQueries().catch(() => undefined);
  }, [dateRange, granularity, api]);

  // Load persisted date range and granularity on mount
  useEffect(() => {
    api.getExplorerPreferences().then(prefs => {
      if (prefs.lastUsedDateRange !== undefined) {
        setDateRange(prefs.lastUsedDateRange);
      }
      if (prefs.lastUsedGranularity !== undefined) {
        setGranularity(prefs.lastUsedGranularity);
      }
      prefsLoadedRef.current = true;
    }).catch(() => {
      prefsLoadedRef.current = true;
    });
  }, [api]);

  // Save date range and granularity whenever they change. The gate only
  // suppresses the save on the very first render, before the mount effect
  // below has loaded (or failed to load) prefs — it does NOT suppress the
  // save caused by the restore itself, which sets the ref in the same batched
  // callback as the state it restores, so opening the view writes back the
  // values it just read. This view doesn't manage column visibility, so it
  // omits hiddenColumns/columnOrder entirely — the save merges onto the
  // on-disk prefs, leaving the user's curated column set (owned by the
  // Explorer) untouched.
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    api.saveExplorerPreferences({
      lastUsedDateRange: dateRange,
      lastUsedGranularity: granularity,
    }).catch(() => undefined);
  }, [dateRange, granularity, api]);

  // Entity detail summary (total, previous, percent change)
  const detailQuery = useQuery(
    () => api.queryEntityDetail({
      entity: asEntityRef(entity),
      dimension: asDimensionId(dimension),
      dateRange,
      filters: {},
      granularity,
      origin: 'entity-detail:summary',
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
      if (isProductDimension(d)) return 1;
      if (isOwnerDimension(d)) return 2;
      if (isUnitDimension(d)) return 3;
      if ('field' in d) return 4;
      return 5;
    };
    return priority(a) - priority(b);
  });

  const serviceDimId = asDimensionId('service');
  const accountDimId = asDimensionId('account');
  const ownerDim = rawDimensions.find(isOwnerDimension);
  const productDim = rawDimensions.find(isProductDimension);
  const regionDimId = asDimensionId('region');

  const effectivePie1 = pie1DimId ?? accountDimId;
  const effectivePie2 = pie2DimId ?? (productDim === undefined ? regionDimId : getDimensionId(productDim));
  const effectivePie3 = pie3DimId ?? serviceDimId;

  // Pie queries — same as overview but scoped to this entity via filter
  const pie1Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie1, dateRange, filters: entityFilter, granularity, origin: `entity-detail:pie1:${String(effectivePie1)}` }),
    [effectivePie1, dateRangeKey, filterKey, granularity, api],
  );
  const pie1Slices = costRowsToSlices(pie1Query.status === 'success' ? pie1Query.data : null);

  const pie2Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie2, dateRange, filters: entityFilter, granularity, origin: `entity-detail:pie2:${String(effectivePie2)}` }),
    [effectivePie2, dateRangeKey, filterKey, granularity, api],
  );
  const pie2Slices = costRowsToSlices(pie2Query.status === 'success' ? pie2Query.data : null);

  const pie3Query = useQuery(
    () => api.queryCosts({ groupBy: effectivePie3, dateRange, filters: entityFilter, granularity, origin: `entity-detail:pie3:${String(effectivePie3)}` }),
    [effectivePie3, dateRangeKey, filterKey, granularity, api],
  );
  const pie3Slices = costRowsToSlices(pie3Query.status === 'success' ? pie3Query.data : null);

  // Histogram — reuse StackedBarChart with queryDailyCosts
  const histogramDimId = (() => {
    if (histogramTab === 'owner' && ownerDim !== undefined) return getDimensionId(ownerDim);
    if (histogramTab === 'product' && productDim !== undefined) return getDimensionId(productDim);
    return serviceDimId;
  })();

  const dailyQuery = useQuery(
    () => api.queryDailyCosts({ groupBy: histogramDimId, dateRange, filters: entityFilter, granularity, origin: `entity-detail:histogram:${String(histogramDimId)}` }),
    [histogramDimId, dateRangeKey, filterKey, granularity, api],
  );
  const barDays = bucketBars(dailyCostsToBarDays(dailyQuery.status === 'success' ? dailyQuery.data : null), 170);

  const handleHistogramRangeSelect = useCallback((startIdx: number, endIdx: number) => {
    if (granularity === 'hourly') {
      // Hourly bars carry "YYYY-MM-DD HH:00" keys — preserve the hour info so
      // the rest of the page (totals, pies, breakdown) filters on the same
      // sub-day window the user dragged across.
      const fallbackEndHour = `${String(dateRange.end)} 23:00:00`;
      const hourRange = computeBucketedHourRange(barDays, startIdx, endIdx, fallbackEndHour);
      if (hourRange === null) return;
      const startDate = hourRange.startHour.slice(0, 10);
      const endDate = hourRange.endHour.slice(0, 10);
      setDateRange({
        start: asDateString(startDate),
        end: asDateString(endDate),
        startHour: asHourString(hourRange.startHour),
        endHour: asHourString(hourRange.endHour),
      });
      setHourlyHint(false);
      return;
    }
    const range = computeBucketedRange(barDays, startIdx, endIdx, dateRange.end);
    if (range === null) return;
    const { startDate, endDate } = range;
    setDateRange({ start: asDateString(startDate), end: asDateString(endDate) });
    if (shouldAutoSwitchToHourly(startDate, endDate, granularity)) {
      if (hourlyConfigured) {
        setGranularity('hourly');
        setHourlyHint(false);
      } else {
        setHourlyHint(true);
      }
    } else {
      setHourlyHint(false);
    }
  }, [barDays, dateRange.end, granularity, hourlyConfigured]);

  useEffect(() => {
    if (!shouldAutoSwitchToHourly(dateRange.start, dateRange.end, granularity)) {
      setHourlyHint(false);
    }
  }, [dateRange.start, dateRange.end, granularity]);

  const totalCost = data === null ? 0 : data.totalCost;
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
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative break-words">
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
                    const neutralOrPositive = isDecrease ? 'text-positive' : 'text-text-secondary';
                    const changeColor = isIncrease ? 'text-negative' : neutralOrPositive;
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
                onRangeSelect={handleHistogramRangeSelect}
              />
              {hourlyHint && (
                <HourlyHintBanner className="mt-2" onDismiss={() => { setHourlyHint(false); }} />
              )}
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
                    return dim === undefined ? dimId : getDimensionLabel(dim);
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
          <EntityBaselinesPanel entity={entity} dimension={dimension} />
        </>
      )}
    </div>
  );
}

function EntityBaselinesPanel({ entity, dimension }: Readonly<{ entity: string; dimension: string }>) {
  const api = useCostApi();
  const query = useQuery(() => api.listBaselines({}), [api]);
  const items = query.status === 'success' ? query.data.items : [];
  const dimId = asDimensionId(dimension);
  const matches = items.filter((r) => {
    if (r.spec.scope.kind !== 'filter') return false;
    const vals = (r.spec.scope.filters[dimId] ?? []).map(String);
    if (vals.length === 0) return false;
    if (vals.includes(entity)) return true;
    // Account scopes store the raw account id in the filter, but entity-detail
    // passes the resolved display name. describeScope put that name into the
    // scopeLabel, so match it there as a token for the account dimension.
    if (dimension === 'account' || dimension === 'account_id') {
      return new Set(r.scopeLabel.split(/ · |, /)).has(entity);
    }
    return false;
  });
  if (matches.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 p-4">
      <h3 className="text-sm font-medium text-text-secondary mb-3">Baselines</h3>
      <div className="flex flex-col divide-y divide-border-subtle">
        {matches.map((r) => (
          <div key={r.spec.id} className="flex items-center gap-3 py-1.5 text-xs">
            <span className="flex-1 truncate text-text-secondary" title={r.scopeLabel}>{r.spec.name ?? r.scopeLabel}</span>
            <BaselineMicroBar lower={r.effectiveLower} upper={r.effectiveUpper} current={r.currentDaily} status={r.status} />
            <span className={`w-24 text-right tabular-nums ${r.savings.potentialMonthly > 0 ? 'text-warning' : 'text-text-muted'}`}>{formatDollars(r.savings.potentialMonthly)}/mo</span>
          </div>
        ))}
      </div>
    </div>
  );
}
