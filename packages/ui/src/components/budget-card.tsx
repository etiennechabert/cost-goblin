import type { BudgetProgress } from '@costgoblin/core/browser';
import { formatDollars } from './format.js';

interface BudgetCardProps {
  readonly progress: BudgetProgress;
  readonly onClick: () => void;
}

export function BudgetCard({ progress, onClick }: Readonly<BudgetCardProps>): React.JSX.Element {
  const { percentUsed, isOverBudget, actualCost, proratedBudget, budget } = progress;
  const barPercent = Math.min(percentUsed, 100);
  const barColor = isOverBudget ? 'bg-negative' : percentUsed > 80 ? 'bg-warning' : 'bg-positive';

  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-border bg-bg-secondary/50 p-5 text-left transition-colors hover:bg-bg-tertiary/30 w-full"
    >
      <p className="font-semibold text-text-primary truncate mb-2" title={budget.entity}>
        {budget.entity}
      </p>
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="text-sm text-text-secondary">
          {formatDollars(actualCost)} / {formatDollars(proratedBudget)}
        </span>
        <span className={`text-sm font-medium tabular-nums ${isOverBudget ? 'text-negative' : 'text-text-primary'}`}>
          {percentUsed.toFixed(0)}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${String(barPercent)}%` }}
        />
      </div>
      <p className="text-xs text-text-muted mt-2">
        Annual: {formatDollars(budget.annualAmount)}
      </p>
    </button>
  );
}
