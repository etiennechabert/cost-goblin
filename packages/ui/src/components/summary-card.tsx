import { daysBetween } from '../lib/dates.js';
import { formatDollars, formatDate } from './format.js';

interface SummaryCardProps {
  /** `null` means "not loaded yet" — the card renders placeholders so the
   *  user doesn't briefly see "$0.00" before the real total lands. */
  totalCost: number | null;
  previousCost?: number | null | undefined;
  dateRange: { start: string; end: string };
  previousDateRange?: { start: string; end: string } | undefined;
}

const PLACEHOLDER = '—';

export function SummaryCard({ totalCost, previousCost, dateRange, previousDateRange }: Readonly<SummaryCardProps>) {
  const hasTotal = totalCost !== null;
  const hasPrevious = previousCost !== null && previousCost !== undefined;
  const delta =
    hasTotal && hasPrevious && previousCost > 0
      ? ((totalCost - previousCost) / previousCost) * 100
      : null;

  const isDecrease = delta !== null && delta < 0;
  const isIncrease = delta !== null && delta > 0;

  const rangeDays = Math.max(1, daysBetween(dateRange.start, dateRange.end));
  const dailyAvg = hasTotal ? totalCost / rangeDays : null;
  const prevRangeDays = previousDateRange !== undefined ? Math.max(1, daysBetween(previousDateRange.start, previousDateRange.end)) : rangeDays;
  const prevDailyAvg = hasPrevious ? previousCost / prevRangeDays : null;

  return (
    <div className="flex flex-col justify-between rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">Total Cost</p>
        <span className="mt-2 block text-4xl font-bold tabular-nums text-text-primary">
          {hasTotal ? formatDollars(totalCost) : PLACEHOLDER}
        </span>
      </div>

      <div className="flex flex-col gap-3 mt-4">
        {(delta !== null || (hasTotal && previousCost === null)) && (
          <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
            <p className="text-xs uppercase tracking-wider text-text-muted">vs Previous Period</p>
            {delta === null ? (
              <p className="mt-1 text-2xl font-bold tabular-nums text-text-muted">{PLACEHOLDER}</p>
            ) : (() => {
              let deltaColor = 'text-text-secondary';
              if (isIncrease) deltaColor = 'text-negative';
              else if (isDecrease) deltaColor = 'text-positive';
              let deltaArrow = '';
              if (isDecrease) deltaArrow = '▼';
              else if (isIncrease) deltaArrow = '▲';
              return (
                <p className={`mt-1 text-2xl font-bold tabular-nums ${deltaColor}`}>
                  {deltaArrow}
                  {Math.abs(delta).toFixed(1)}%
                </p>
              );
            })()}
            {hasPrevious && (
              <p className="mt-0.5 text-xs text-text-muted">
                Previous: {formatDollars(previousCost)}
              </p>
            )}
          </div>
        )}

        <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
          <p className="text-xs uppercase tracking-wider text-text-muted">Daily Average</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">
            {dailyAvg === null ? PLACEHOLDER : formatDollars(dailyAvg)}
          </p>
          {prevDailyAvg !== null && (
            <p className="mt-0.5 text-xs text-text-muted">
              Previous: {formatDollars(prevDailyAvg)}/day
            </p>
          )}
        </div>
      </div>

      <p className="mt-3 text-xs text-text-muted">
        {formatDate(dateRange.start)} – {formatDate(dateRange.end)}
      </p>
    </div>
  );
}
