import { formatDollars, formatDate } from './format.js';

interface SummaryCardProps {
  totalCost: number;
  previousCost?: number;
  dateRange: { start: string; end: string };
}

export function SummaryCard({ totalCost, previousCost, dateRange }: SummaryCardProps) {
  const delta =
    previousCost !== undefined && previousCost > 0
      ? ((totalCost - previousCost) / previousCost) * 100
      : null;

  const isDecrease = delta !== null && delta < 0;
  const isIncrease = delta !== null && delta > 0;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5">
      <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">Total Cost</p>
      <div className="mt-1 flex items-end gap-3">
        <span className="text-4xl font-bold tabular-nums text-text-primary">
          {formatDollars(totalCost)}
        </span>
        {delta !== null && (
          <span
            className={[
              'mb-1 flex items-center gap-0.5 text-sm font-medium tabular-nums',
              isDecrease ? 'text-positive' : isIncrease ? 'text-negative' : 'text-text-secondary',
            ].join(' ')}
          >
            {isDecrease ? '▼' : isIncrease ? '▲' : ''}
            {Math.abs(delta).toFixed(1)}%
            <span className="ml-1 font-normal text-text-secondary">vs prev period</span>
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-text-secondary">
        {formatDate(dateRange.start)} – {formatDate(dateRange.end)}
      </p>
    </div>
  );
}
