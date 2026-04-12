import { formatDollars, formatDate } from './format.js';

interface SummaryCardProps {
  totalCost: number;
  previousCost?: number | undefined;
  dateRange: { start: string; end: string };
}

export function SummaryCard({ totalCost, previousCost, dateRange }: SummaryCardProps) {
  const delta =
    previousCost !== undefined && previousCost > 0
      ? ((totalCost - previousCost) / previousCost) * 100
      : null;

  const isDecrease = delta !== null && delta < 0;
  const isIncrease = delta !== null && delta > 0;

  const dailyAvg = (() => {
    const start = new Date(dateRange.start).getTime();
    const end = new Date(dateRange.end).getTime();
    const days = Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1);
    return totalCost / days;
  })();

  return (
    <div className="flex flex-col justify-between rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">Total Cost</p>
        <span className="mt-2 block text-4xl font-bold tabular-nums text-text-primary">
          {formatDollars(totalCost)}
        </span>
      </div>

      <div className="flex flex-col gap-3 mt-4">
        {delta !== null && (
          <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
            <p className="text-xs uppercase tracking-wider text-text-muted">vs Previous Period</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums ${(() => { if (isIncrease) return 'text-negative'; if (isDecrease) return 'text-positive'; return 'text-text-secondary'; })()}`}>
              {(() => { if (isDecrease) return '▼'; if (isIncrease) return '▲'; return ''; })()}
              {Math.abs(delta).toFixed(1)}%
            </p>
            {previousCost !== undefined && (
              <p className="mt-0.5 text-xs text-text-muted">
                Previous: {formatDollars(previousCost)}
              </p>
            )}
          </div>
        )}

        <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
          <p className="text-xs uppercase tracking-wider text-text-muted">Daily Average</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">
            {formatDollars(dailyAvg)}
          </p>
        </div>
      </div>

      <p className="mt-3 text-xs text-text-muted">
        {formatDate(dateRange.start)} – {formatDate(dateRange.end)}
      </p>
    </div>
  );
}
