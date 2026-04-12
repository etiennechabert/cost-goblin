import { useState } from 'react';
import type {
  EntityDetailResult,
  DistributionSlice,
} from '@costgoblin/core/browser';
import { asDimensionId, asEntityRef } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars, formatPercent } from '../components/format.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange } from '../components/date-range-picker.js';

interface EntityDetailProps {
  entity: string;
  dimension: string;
  onBack: () => void;
}

type HistogramGroupBy = 'service' | 'account';

function DistributionSection({
  title,
  items,
  color,
  onItemClick,
}: {
  title: string;
  items: readonly DistributionSlice[];
  color: string;
  onItemClick?: (name: string) => void;
}) {
  const maxPct = items.reduce((m, i) => Math.max(m, i.percentage), 0);

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
      <h3 className="mb-3 text-sm font-medium text-text-secondary">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">No data</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.slice(0, 10).map((item) => {
            const barWidth = maxPct > 0 ? (item.percentage / maxPct) * 100 : 0;
            return (
              <div key={item.name} className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => { onItemClick?.(item.name); }}
                  className="w-36 shrink-0 truncate text-left text-text-secondary hover:text-accent transition-colors"
                  title={item.name}
                >
                  {item.name}
                </button>
                <div className="relative h-3 flex-1 rounded-sm bg-bg-tertiary">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-sm ${color}`}
                    style={{ width: `${String(barWidth)}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right tabular-nums text-text-primary">
                  {formatDollars(item.cost)}
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums text-text-muted">
                  {item.percentage.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
    '',
    'Sub-Entity,Cost,Percentage',
    ...data.bySubEntity.map((r) => `${r.name},${String(r.cost)},${String(r.percentage)}`),
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

const HIST_COLORS = [
  'bg-emerald-500', 'bg-cyan-500', 'bg-amber-500', 'bg-violet-500',
  'bg-rose-500', 'bg-blue-500', 'bg-orange-500', 'bg-teal-500',
];

export function EntityDetail({ entity, dimension, onBack }: EntityDetailProps) {
  const api = useCostApi();
  const [histogramGroup, setHistogramGroup] = useState<HistogramGroupBy>('service');
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);

  const dateRangeKey = `${dateRange.start}_${dateRange.end}`;

  const detailQuery = useQuery(
    () =>
      api.queryEntityDetail({
        entity: asEntityRef(entity),
        dimension: asDimensionId(dimension),
        dateRange,
        filters: {},
      }),
    [entity, dimension, dateRangeKey, api],
  );

  const data: EntityDetailResult | null =
    detailQuery.status === 'success' ? detailQuery.data : null;

  const last30Days = data !== null ? data.dailyCosts.slice(-30) : [];
  const maxDailyCost = last30Days.reduce((m, d) => Math.max(m, d.cost), 0);
  const isIncrease = data !== null && data.percentChange > 0;
  const isDecrease = data !== null && data.percentChange < 0;

  const allBreakdownKeys = new Set<string>();
  for (const day of last30Days) {
    const bd = histogramGroup === 'account' ? day.breakdownByAccount : day.breakdown;
    for (const key of Object.keys(bd)) {
      allBreakdownKeys.add(key);
    }
  }
  const breakdownKeys = [...allBreakdownKeys];

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
          <DateRangePicker value={dateRange} onChange={setDateRange} />
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

      {detailQuery.status === 'loading' && (
        <div className="text-sm text-text-secondary">Loading...</div>
      )}
      {detailQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {detailQuery.error.message}
        </div>
      )}

      {data !== null && (
        <>
          {/* Row 1: Summary cards + Daily histogram */}
          <div className="grid grid-cols-3 gap-4">
            {/* Total + delta */}
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
                <p className="text-xs uppercase tracking-wider text-text-muted">Total</p>
                <p className="mt-1 text-3xl font-bold tabular-nums text-text-primary">
                  {formatDollars(data.totalCost)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
                <p className="text-xs uppercase tracking-wider text-text-muted">vs Previous Period</p>
                <p className={`mt-1 text-2xl font-bold tabular-nums ${isIncrease ? 'text-negative' : isDecrease ? 'text-positive' : 'text-text-secondary'}`}>
                  {formatPercent(data.percentChange)}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  Previous: {formatDollars(data.previousCost)}
                </p>
              </div>
            </div>

            {/* Daily costs histogram — spans 2 columns */}
            <div className="col-span-2 rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-text-secondary">Daily Costs</h3>
                <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
                  {(['service', 'account'] as const).map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => { setHistogramGroup(g); }}
                      className={[
                        'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors capitalize',
                        histogramGroup === g
                          ? 'bg-bg-secondary text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary',
                      ].join(' ')}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
              {last30Days.length > 0 ? (
                <div>
                  <div className="flex items-end" style={{ height: '160px', gap: '3px' }}>
                    {last30Days.map((day) => {
                      const bd = histogramGroup === 'account' ? day.breakdownByAccount : day.breakdown;
                      const barPct = maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0;
                      const segments = breakdownKeys
                        .map((key, ki) => ({
                          key,
                          value: bd[key] ?? 0,
                          colorIdx: ki,
                        }))
                        .filter(s => s.value > 0);
                      const segTotal = segments.reduce((sum, s) => sum + s.value, 0);

                      return (
                        <div
                          key={day.date}
                          className="group relative flex-1 min-w-0 cursor-pointer"
                          style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
                        >
                          <div
                            className="w-full overflow-hidden rounded-t-sm"
                            style={{ height: `${String(barPct)}%`, minHeight: barPct > 0 ? '2px' : '0' }}
                          >
                            {segments.map(seg => {
                              const pct = segTotal > 0 ? (seg.value / segTotal) * 100 : 0;
                              return (
                                <div
                                  key={seg.key}
                                  className={`w-full ${HIST_COLORS[seg.colorIdx % HIST_COLORS.length] ?? ''} opacity-80 group-hover:opacity-100 transition-opacity`}
                                  style={{ height: `${String(pct)}%` }}
                                />
                              );
                            })}
                          </div>
                          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="rounded bg-bg-secondary/90 px-2 py-1 text-[10px] text-text-primary whitespace-nowrap shadow-lg border border-border">
                              <div className="font-medium">{day.date.slice(5)}</div>
                              <div>{formatDollars(day.cost)}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex mt-1" style={{ gap: '3px' }}>
                    {last30Days.map((day, idx) => (
                      <div key={day.date} className="flex-1 min-w-0 text-center">
                        {idx % 5 === 0 ? (
                          <span className="text-[10px] text-text-muted">{day.date.slice(5)}</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-32 text-sm text-text-muted">No daily data</div>
              )}
              <div className="mt-7" />
            </div>
          </div>

          {/* Row 2: Distribution charts */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <DistributionSection
              title="Accounts"
              items={data.byAccount}
              color="bg-cyan-500"
            />
            <DistributionSection
              title="Services"
              items={data.byService}
              color="bg-emerald-500"
            />
            <DistributionSection
              title="Sub-Entities"
              items={data.bySubEntity}
              color="bg-violet-500"
            />
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
