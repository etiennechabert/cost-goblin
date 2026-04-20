import { formatDollars, formatDate } from './format.js';

interface SummaryCardProps {
  /** `null` means "not loaded yet" — the card renders placeholders so the
   *  user doesn't briefly see "$0.00" before the real total lands. */
  totalCost: number | null;
  previousCost?: number | null | undefined;
  dateRange: { start: string; end: string };
}

const PLACEHOLDER = '—';

export function SummaryCard({ totalCost, previousCost, dateRange }: Readonly<SummaryCardProps>) {
  const hasTotal = totalCost !== null;
  const hasPrevious = previousCost !== null && previousCost !== undefined;
  const delta =
    hasTotal && hasPrevious && previousCost > 0
      ? ((totalCost - previousCost) / previousCost) * 100
      : null;

  const isDecrease = delta !== null && delta < 0;
  const isIncrease = delta !== null && delta > 0;

  const rangeStart = new Date(dateRange.start).getTime();
  const rangeEnd = new Date(dateRange.end).getTime();
  const rangeDays = Math.max(1, Math.round((rangeEnd - rangeStart) / (24 * 60 * 60 * 1000)) + 1);
  const dailyAvg = hasTotal ? totalCost / rangeDays : null;

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
              const deltaColor = isIncrease ? 'text-negative' : isDecrease ? 'text-positive' : 'text-text-secondary';
              const deltaArrow = isDecrease ? '▼' : isIncrease ? '▲' : '';
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
        </div>
      </div>

      <p className="mt-3 text-xs text-text-muted">
        {formatDate(dateRange.start)} – {formatDate(dateRange.end)}
      </p>
    </div>
  );
}
