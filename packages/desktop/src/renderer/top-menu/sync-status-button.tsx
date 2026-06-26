import { useState } from 'react';
import { CloudDownload, RefreshCw } from 'lucide-react';
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
  onRecheck: () => Promise<void>;
}

function syncBarFraction(status: Extract<SyncStatus, { status: 'syncing' }>): number {
  if (status.bytesTotal > 0) return status.bytesDone / status.bytesTotal;
  if (status.filesTotal > 0) return status.filesDone / status.filesTotal;
  return 0;
}

function tierState(status: SyncStatus, synced: boolean): React.JSX.Element {
  switch (status.status) {
    case 'syncing':
      return <span className="tabular-nums text-accent">{String(status.filesDone)}/{String(status.filesTotal)} files</span>;
    case 'completed':
      return <span className="text-text-muted">synced</span>;
    case 'failed':
      return <span className="text-negative">failed</span>;
    case 'idle':
      // `idle` just means "no download running" — the in-memory status resets to
      // it on every launch. Read it as "synced" when nothing is outstanding so it
      // doesn't contradict the "All periods synced" footer.
      return <span className="text-text-muted">{synced ? 'synced' : 'idle'}</span>;
  }
}

function SyncTierRow({ label, status, synced }: Readonly<{ label: string; status: SyncStatus; synced: boolean }>): React.JSX.Element {
  const bar = status.status === 'syncing'
    ? Math.min(100, Math.max(0, Math.round(syncBarFraction(status) * 100)))
    : null;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        {tierState(status, synced)}
      </div>
      {bar !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-tertiary">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${String(bar)}%` }} />
        </div>
      )}
    </div>
  );
}

function buttonTitle(opts: Readonly<{ showError: boolean; error: string | null; showActive: boolean; showMissing: boolean; missingPeriods: number }>): string {
  const { showError, error, showActive, showMissing, missingPeriods } = opts;
  if (showError) return `Sync error — ${error ?? ''}`;
  if (showActive) return 'Syncing…';
  if (showMissing) return `${String(missingPeriods)} billing period${missingPeriods === 1 ? '' : 's'} not synced`;
  return 'Data sync';
}

/** Dedicated data-sync indicator, split out of the Settings gear. Shows whether
 *  a download is in progress (and how many files remain), surfaces sync errors,
 *  and flags un-synced periods — with a per-tier breakdown on click, so the user
 *  doesn't have to open Settings › Data just to see activity. */
export function SyncStatusButton({
  activity, error, filesRemaining, missingPeriods, tiers, inSettingsData, onManageData, onRecheck,
}: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const synced = missingPeriods === 0;

  function handleRecheck(): void {
    if (rechecking) return;
    setRechecking(true);
    void onRecheck().finally(() => { setRechecking(false); });
  }

  const showError = error !== null;
  const showActive = !showError && activity !== 'idle';
  const showMissing = !showError && activity === 'idle' && missingPeriods > 0 && !inSettingsData;

  const title = buttonTitle({ showError, error, showActive, showMissing, missingPeriods });
  const periodPlural = missingPeriods === 1 ? '' : 's';
  const footerLabel = missingPeriods > 0
    ? `${String(missingPeriods)} period${periodPlural} not synced`
    : 'All periods synced';

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
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CloudDownload size={14} className="text-accent" />
            <span className="text-sm font-semibold">Data sync</span>
          </div>
          <button
            type="button"
            onClick={handleRecheck}
            disabled={rechecking}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            title="Check for new data"
            aria-label="Check for new data"
          >
            <RefreshCw size={13} className={rechecking ? 'animate-spin' : undefined} />
          </button>
        </div>
        {showError && (
          <div className="mb-2 rounded-md border border-negative/50 bg-negative-muted px-2.5 py-1.5 text-xs text-negative">{error}</div>
        )}
        <div className="divide-y divide-border-subtle">
          {tiers.map(t => <SyncTierRow key={t.id} label={t.label} status={t.status} synced={synced} />)}
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
          <span className="text-[11px] text-text-muted">
            {footerLabel}
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
