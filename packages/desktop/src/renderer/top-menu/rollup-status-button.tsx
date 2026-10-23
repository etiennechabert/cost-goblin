import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { ButtonTooltip, Popover, PopoverTrigger, PopoverContent, RollupStatusDetail } from '@costgoblin/ui';
import type { TooltipStatus } from '@costgoblin/ui';
import type { RollupStatus, RollupStats } from '@costgoblin/core/browser';

interface Props {
  status: RollupStatus;
}

function months(n: number): string {
  return `${String(n)} month${n === 1 ? '' : 's'}`;
}

/** The live status the tooltip gives under its line ("Rollup" is its name). */
function tooltipStatus(status: RollupStatus): TooltipStatus {
  switch (status.state) {
    case 'computing':
      return { text: status.total > 0 ? `Rebuilding… ${String(status.done)}/${String(status.total)}` : 'Rebuilding…', tone: 'busy' };
    case 'failed':
      return { text: `Build failed — ${status.message}`, tone: 'error' };
    case 'ready':
      return { text: `Ready — ${months(status.periods)} pre-aggregated`, tone: 'ok' };
    case 'idle':
      return { text: 'Not built — dashboards query raw data', tone: 'warning' };
  }
}

/** Header indicator for the on-disk daily rollup. Dashboards silently fall back
 *  to the slower raw path while a re-roll runs (after a dimensions save or a
 *  sync); this surfaces that window — and any swallowed build failure — with a
 *  click-through detail popover. */
export function RollupStatusButton({ status }: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<RollupStats | null>(null);

  // Size KPIs are pulled on demand (popover open + ready) rather than pushed —
  // they only matter when the user looks. Raw size is read server-side from the
  // local filesystem, so it works without AWS credentials.
  useEffect(() => {
    if (!open || status.state !== 'ready') return undefined;
    let cancelled = false;
    globalThis.costgoblinRollup.getStats().then((s) => { if (!cancelled) setStats(s); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, status.state]);

  const computing = status.state === 'computing';
  const failed = status.state === 'failed';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ButtonTooltip name="Rollup" description="Pre-aggregated data for fast dashboards" status={tooltipStatus(status)} suppressed={open}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Rollup status"
            className={[
              'relative rounded-md p-1.5 transition-colors',
              open
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            ].join(' ')}
          >
            <Layers size={16} className={computing ? 'text-accent' : undefined} />
            {failed && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[10px] font-bold text-white">!</span>
            )}
            {computing && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent animate-pulse" aria-hidden="true" />
            )}
          </button>
        </PopoverTrigger>
      </ButtonTooltip>
      <PopoverContent align="end" className="w-72" arrow>
        <div className="mb-2 flex items-center gap-2">
          <Layers size={14} className="text-accent" />
          <span className="text-sm font-semibold">Rollup</span>
        </div>
        <RollupStatusDetail status={status} stats={stats} />
      </PopoverContent>
    </Popover>
  );
}
