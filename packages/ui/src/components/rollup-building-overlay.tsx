import { Layers } from 'lucide-react';
import type { RollupStatus } from '@costgoblin/core/browser';
import { RollupStatusDetail } from './rollup-status-detail.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatMonth(period: string): string {
  const [year, month] = period.split('-');
  const name = MONTH_NAMES[Number(month) - 1] ?? month ?? period;
  const yy = (year ?? '').slice(2);
  return yy === '' ? name : `${name} '${yy}`;
}

function periodLabel(months: readonly string[]): string {
  if (months.length === 0) return 'the selected period';
  if (months.length === 1) return formatMonth(months[0] ?? '');
  return `${formatMonth(months[0] ?? '')}–${formatMonth(months.at(-1) ?? '')}`;
}

interface Props {
  readonly status: RollupStatus;
  /** Months the user is currently viewing — named in the headline and ringed in
   *  the chip list so they can see their data's progress specifically. */
  readonly pendingMonths: readonly string[];
}

/** Full-area "building your data" panel shown over a rollup-backed view while
 *  the selected period's rollup is still being built (cold first build). It
 *  replaces the widget grid — so the slow raw queries never fire — and clears
 *  itself the moment the period's partitions are ready, letting the view mount
 *  and load. The app header stays usable above it. */
export function RollupBuildingOverlay({ status, pendingMonths }: Props): React.JSX.Element {
  return (
    <div className="flex min-h-[55vh] flex-1 items-center justify-center rounded-2xl border border-border bg-bg-secondary/40 p-8">
      <div className="w-full max-w-md space-y-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-accent/30 bg-accent/10">
          <Layers size={22} className="animate-pulse text-accent" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-lg font-semibold text-text-primary">Preparing your cost data</h3>
          <p className="text-sm text-text-secondary">
            CostGoblin is pre-aggregating <span className="font-medium text-text-primary">{periodLabel(pendingMonths)}</span> into
            the rollup. This view loads automatically as soon as it's ready.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-bg-primary/50 p-4 text-left">
          <RollupStatusDetail status={status} highlight={pendingMonths} />
        </div>
        <p className="text-xs text-text-muted">
          Switch to an already-built month — or open Explorer — to browse while this finishes.
        </p>
      </div>
    </div>
  );
}
