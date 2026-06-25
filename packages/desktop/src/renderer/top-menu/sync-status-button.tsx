import { useState } from 'react';
import { CloudDownload } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@costgoblin/ui';
import type { SyncStatus } from '@costgoblin/core/browser';

export type SyncActivity = 'idle' | 'syncing' | 'downloading';

export interface SyncTier {
  readonly id: string;
  readonly label: string;
  readonly status: SyncStatus;
}

interface Props {
  activity: SyncActivity;
  error: string | null;
  filesRemaining: number;
  missingPeriods: number;
  tiers: readonly SyncTier[];
  inSettingsData: boolean;
  onManageData: () => void;
}

function tierState(status: SyncStatus): React.JSX.Element {
  switch (status.status) {
    case 'syncing':
      return <span className="tabular-nums text-accent">{String(status.filesDone)}/{String(status.filesTotal)} files</span>;
    case 'completed':
      return <span className="text-text-muted">up to date</span>;
    case 'failed':
      return <span className="text-negative">failed</span>;
    case 'idle':
      return <span className="text-text-muted">idle</span>;
  }
}

function SyncTierRow({ label, status }: Readonly<{ label: string; status: SyncStatus }>): React.JSX.Element {
  const bar = status.status === 'syncing'
    ? (() => {
        const fraction = status.bytesTotal > 0
          ? status.bytesDone / status.bytesTotal
          : (status.filesTotal > 0 ? status.filesDone / status.filesTotal : 0);
        return Math.min(100, Math.max(0, Math.round(fraction * 100)));
      })()
    : null;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        {tierState(status)}
      </div>
      {bar !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-tertiary">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${String(bar)}%` }} />
        </div>
      )}
    </div>
  );
}

/** Dedicated data-sync indicator, split out of the Settings gear. Shows whether
 *  a download is in progress (and how many files remain), surfaces sync errors,
 *  and flags un-synced periods — with a per-tier breakdown on click, so the user
 *  doesn't have to open Settings › Data just to see activity. */
export function SyncStatusButton({
  activity, error, filesRemaining, missingPeriods, tiers, inSettingsData, onManageData,
}: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const showError = error !== null;
  const showActive = !showError && activity !== 'idle';
  const showMissing = !showError && activity === 'idle' && missingPeriods > 0 && !inSettingsData;

  const title = showError
    ? `Sync error — ${error}`
    : showActive
      ? 'Syncing…'
      : showMissing
        ? `${String(missingPeriods)} billing period${missingPeriods === 1 ? '' : 's'} not synced`
        : 'Data sync';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Data sync"
          title={title}
          className={[
            'relative rounded-md p-1.5 transition-colors',
            open
              ? 'bg-bg-tertiary text-text-primary'
              : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            showError ? 'ring-1 ring-negative/60' : '',
            showActive ? 'animate-sync-blink' : '',
          ].join(' ')}
        >
          <CloudDownload size={16} />
          {showError && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[10px] font-bold text-white">!</span>
          )}
          {showActive && filesRemaining > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">{String(filesRemaining)}</span>
          )}
          {showActive && filesRemaining === 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent animate-pulse" aria-hidden="true" />
          )}
          {showMissing && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-bold text-bg-primary">{String(missingPeriods)}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="mb-2 flex items-center gap-2">
          <CloudDownload size={14} className="text-accent" />
          <span className="text-sm font-semibold">Data sync</span>
        </div>
        {showError && (
          <div className="mb-2 rounded-md border border-negative/50 bg-negative-muted px-2.5 py-1.5 text-xs text-negative">{error}</div>
        )}
        <div className="divide-y divide-border-subtle">
          {tiers.map(t => <SyncTierRow key={t.id} label={t.label} status={t.status} />)}
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
          <span className="text-[11px] text-text-muted">
            {missingPeriods > 0
              ? `${String(missingPeriods)} period${missingPeriods === 1 ? '' : 's'} not synced`
              : 'All periods synced'}
          </span>
          <button
            type="button"
            onClick={() => { setOpen(false); onManageData(); }}
            className="text-[11px] font-medium text-accent hover:underline"
          >
            Manage data
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
