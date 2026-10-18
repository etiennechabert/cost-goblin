import type { ReactNode } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

import { SUMMARY_CARD_CLASS, SummaryCard } from '../components/summary-card.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { formatDateRange, formatDollars, formatPercent, signedDollars } from '../components/format.js';
import { asDimensionId, trendPercentChange } from '@costgoblin/core/browser';
import type { CostResult, CostRow, DateRange, SummaryMetric } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, hasSufficientCoverage, summaryGroupBy, summaryUsesGroupBy } from './widget.js';

const PLACEHOLDER = '—';

/** How an entity with no value for the dimension (an untagged row's NULL,
 *  which arrives as '') is named. */
const NO_VALUE = '(no value)';

/** Under half a cent, a period's total is float residue from charges and
 *  credits netting out, not spend: no ratio is taken against it. */
const RESIDUE = 0.005;

export function SummaryWidget({
  dateRange,
  previousDateRange,
  compareEnabled,
  granularity,
  globalFilters,
  dimensions,
  spec,
}: WidgetCommonProps) {
  const api = useCostApi();
  const summary = spec.type === 'summary' ? spec : null;
  const isSummary = summary !== null;
  const metric: SummaryMetric = summary?.metric ?? 'total';
  // `total` and `delta` only read the period's total, which any grouping
  // gives; they keep the account grouping the widget has always queried.
  const groupBy = summary !== null && summaryUsesGroupBy(metric)
    ? summaryGroupBy(summary.groupBy)
    : asDimensionId('account');
  // `delta` is the comparison itself, so it reads the previous period even
  // while the global compare toggle is off.
  const needsPrevious = metric === 'delta' || (metric === 'total' && compareEnabled);
  const fk = filtersKey(globalFilters);

  const cur = useQuery<CostResult | null>(
    () => isSummary ? api.queryCosts({ groupBy, dateRange, filters: globalFilters, granularity, origin: `widget:summary:${metric}` }) : Promise.resolve(null),
    [isSummary, metric, groupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, api],
  );
  const prev = useQuery<CostResult | null>(
    () => isSummary && needsPrevious ? api.queryCosts({ groupBy, dateRange: previousDateRange, filters: globalFilters, granularity, origin: `widget:summary:${metric}/prev` }) : Promise.resolve(null),
    [isSummary, needsPrevious, metric, groupBy, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, fk, granularity, api],
  );

  if (summary === null) return null;

  if (cur.status === 'loading' || (metric === 'delta' && prev.status === 'loading')) return (
    <div className={SUMMARY_CARD_CLASS}>
      <CoinRainLoader height={200} count={4} />
    </div>
  );

  let failed: Error | null = null;
  if (cur.status === 'error') failed = cur.error;
  else if (metric === 'delta' && prev.status === 'error') failed = prev.error;
  if (failed !== null) return (
    <div className={SUMMARY_CARD_CLASS}>
      <div className="flex items-center justify-center h-full text-xs text-warning">Query failed: {failed.message}</div>
    </div>
  );

  const current = cur.status === 'success' ? cur.data : null;
  const prevData = prev.status === 'success' ? prev.data : null;
  const previousComplete = prevData !== null && hasSufficientCoverage(prevData, previousDateRange);
  const previousCost = previousComplete ? prevData.totalCost : null;
  const label = dimensionLabelFor(dimensions, groupBy);

  switch (metric) {
    case 'total':
      return (
        <SummaryCard
          label={summary.title}
          totalCost={current === null ? null : current.totalCost}
          previousCost={previousCost}
          dateRange={dateRange}
          previousDateRange={previousComplete ? previousDateRange : undefined}
        />
      );
    case 'delta':
      return (
        <DeltaCard
          label={summary.title ?? 'Change vs previous period'}
          current={current === null ? 0 : current.totalCost}
          previous={previousCost}
          dateRange={dateRange}
          previousDateRange={previousDateRange}
        />
      );
    case 'topEntity':
      return <TopEntityCard label={summary.title ?? `Top ${label}`} result={current} dateRange={dateRange} />;
    case 'entityCount':
      return (
        <SummaryShell label={summary.title ?? `${label} count`} footer={formatDateRange(dateRange)}>
          <span className="mt-2 block text-4xl font-bold tabular-nums text-text-primary">
            {current === null ? PLACEHOLDER : current.rows.filter(r => r.entity !== '').length.toLocaleString('en-US')}
          </span>
          <p className="mt-1 text-xs text-text-muted">Distinct values in range</p>
        </SummaryShell>
      );
  }
}

function SummaryShell({ label, footer, children }: Readonly<{
  label: string;
  footer: string;
  children: ReactNode;
}>) {
  return (
    <div className={SUMMARY_CARD_CLASS}>
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">{label}</p>
        {children}
      </div>
      <p className="mt-3 text-xs text-text-muted">{footer}</p>
    </div>
  );
}

function DeltaCard({ label, current, previous, dateRange, previousDateRange }: Readonly<{
  label: string;
  current: number;
  /** `null` when the previous period has too little data to compare. */
  previous: number | null;
  dateRange: DateRange;
  previousDateRange: DateRange;
}>) {
  const footer = `${formatDateRange(dateRange)} vs ${formatDateRange(previousDateRange)}`;
  if (previous === null) return (
    <SummaryShell label={label} footer={footer}>
      <span className="mt-2 block text-4xl font-bold tabular-nums text-text-muted">{PLACEHOLDER}</span>
      <p className="mt-1 text-xs text-text-muted">Not enough data for the previous period</p>
    </SummaryShell>
  );

  // In whole cents, so residue neither colors the card nor prints "$-0.00"
  // (`+ 0` turns -0 into 0).
  const change = Math.round((current - previous) * 100) / 100 + 0;
  let color = 'text-text-primary';
  if (change > 0) color = 'text-negative';
  else if (change < 0) color = 'text-positive';
  // A change from $0 has no ratio; say so rather than show trends' ±100%.
  const percent = Math.abs(previous) < RESIDUE ? null : trendPercentChange(current, previous);

  return (
    <SummaryShell label={label} footer={footer}>
      <span className={`mt-2 block text-4xl font-bold tabular-nums ${color}`}>{signedDollars(change)}</span>
      <div className="mt-4 rounded-lg bg-bg-tertiary/30 px-4 py-3">
        {percent === null
          ? <p className="text-sm text-text-muted">No spend in the previous period</p>
          : <p className={`text-2xl font-bold tabular-nums ${color}`}>{formatPercent(percent)}</p>}
        <p className="mt-0.5 text-xs tabular-nums text-text-muted">This period: {formatDollars(current)}</p>
        <p className="mt-0.5 text-xs tabular-nums text-text-muted">Previous: {formatDollars(previous)}</p>
      </div>
    </SummaryShell>
  );
}

function TopEntityCard({ label, result, dateRange }: Readonly<{
  label: string;
  result: CostResult | null;
  dateRange: DateRange;
}>) {
  // The query sorts by cost, but pick the costliest explicitly rather than
  // lean on the row order.
  const rows = result === null ? [] : result.rows;
  const top = rows.reduce<CostRow | null>(
    (best, r) => best === null || r.totalCost > best.totalCost ? r : best,
    null,
  );
  if (result === null || top === null) return (
    <SummaryShell label={label} footer={formatDateRange(dateRange)}>
      <span className="mt-2 block text-4xl font-bold tabular-nums text-text-muted">{PLACEHOLDER}</span>
      <p className="mt-1 text-xs text-text-muted">No spend in range</p>
    </SummaryShell>
  );

  const name = top.entity === '' ? NO_VALUE : top.entity;
  const total = result.totalCost;
  return (
    <SummaryShell label={label} footer={formatDateRange(dateRange)}>
      <span className="mt-2 block truncate text-2xl font-bold text-text-primary" title={name}>{name}</span>
      <span className="mt-1 block text-xl font-semibold tabular-nums text-text-primary">{formatDollars(top.totalCost)}</span>
      {total > 0 && (
        <p className="mt-0.5 text-xs tabular-nums text-text-muted">
          {`${((top.totalCost / total) * 100).toFixed(1)}% of ${formatDollars(total)}`}
        </p>
      )}
    </SummaryShell>
  );
}
