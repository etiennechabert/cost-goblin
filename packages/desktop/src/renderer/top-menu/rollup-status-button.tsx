import { useState } from 'react';
import { Layers } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@costgoblin/ui';
import type { RollupStatus } from '@costgoblin/core/browser';

interface Props {
  status: RollupStatus;
}

function months(n: number): string {
  return `${String(n)} month${n === 1 ? '' : 's'}`;
}

function tooltipFor(status: RollupStatus): string {
  switch (status.state) {
    case 'computing':
      return status.total > 0
        ? `Rebuilding rollup… ${String(status.done)}/${String(status.total)}`
        : 'Rebuilding rollup…';
    case 'failed':
      return `Rollup build failed — ${status.message}`;
    case 'ready':
      return `Rollup ready — ${months(status.periods)} pre-aggregated`;
    case 'idle':
      return 'Rollup not built — dashboards query raw data';
  }
}

/** Header indicator for the on-disk daily rollup. Dashboards silently fall back
 *  to the slower raw path while a re-roll runs (after a dimensions save or a
 *  sync); this surfaces that window — and any swallowed build failure — with a
 *  click-through detail popover. */
export function RollupStatusButton({ status }: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const computing = status.state === 'computing';
  const failed = status.state === 'failed';
  const pct = status.state === 'computing' && status.total > 0
    ? Math.round((status.done / status.total) * 100)
    : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Rollup status"
          title={tooltipFor(status)}
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
      <PopoverContent align="end" className="w-72">
        <div className="mb-2 flex items-center gap-2">
          <Layers size={14} className="text-accent" />
          <span className="text-sm font-semibold">Rollup</span>
        </div>
        {status.state === 'computing' && (
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">Rebuilding the pre-aggregated rollup. Dashboards read raw data until it finishes.</p>
            {status.total > 0 && (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${String(pct)}%` }} />
                </div>
                <p className="text-[11px] tabular-nums text-text-muted">{String(status.done)} / {String(status.total)} months</p>
              </>
            )}
          </div>
        )}
        {status.state === 'ready' && (
          <p className="text-xs text-text-secondary">
            Dashboards are served from the pre-aggregated rollup — <span className="font-medium tabular-nums text-text-primary">{months(status.periods)}</span> built.
          </p>
        )}
        {status.state === 'idle' && (
          <p className="text-xs text-text-secondary">No rollup is built yet. Dashboards query the raw data directly.</p>
        )}
        {status.state === 'failed' && (
          <div className="space-y-1">
            <p className="text-xs text-negative">{status.message}</p>
            <p className="text-[11px] text-text-muted">Dashboards fall back to raw data. Reload data or re-save dimensions to retry.</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
