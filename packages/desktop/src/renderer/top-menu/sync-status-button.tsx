import { useRef, useState } from 'react';
import { CloudDownload, RefreshCw } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent, formatRelativeTime, SsoLoginButton, GcloudLoginButton, RetryButton } from '@costgoblin/ui';
import { GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND } from '@costgoblin/core/browser';
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
  /** The current (in-progress) month has newer remote data than what's local.
   *  Shown as an informational "updating" note rather than counted as un-synced,
   *  since the current month is almost always stale as CUR re-publishes. */
  currentMonthUpdating: boolean;
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

/** The durable "last synced" time for a tier, or null while syncing / never
 *  synced. The main process backfills this onto idle/failed statuses from disk
 *  so it survives restarts. */
function statusLastSync(status: SyncStatus): Date | null {
  switch (status.status) {
    case 'syncing': return null;
    case 'completed': return status.lastSync;
    case 'idle':
    case 'failed': return status.lastSync;
  }
}

function SyncTierRow({ label, status, synced }: Readonly<{ label: string; status: SyncStatus; synced: boolean }>): React.JSX.Element {
  const bar = status.status === 'syncing'
    ? Math.min(100, Math.max(0, Math.round(syncBarFraction(status) * 100)))
    : null;
  const lastSync = statusLastSync(status);
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        <div className="flex items-center gap-1.5">
          {tierState(status, synced)}
          {lastSync !== null && (
            <span className="text-[10px] text-text-muted" title={lastSync.toLocaleString()}>· {formatRelativeTime(lastSync)}</span>
          )}
        </div>
      </div>
      {bar !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-tertiary">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${String(bar)}%` }} />
        </div>
      )}
    </div>
  );
}

function buttonTitle(opts: Readonly<{ showError: boolean; error: string | null; showActive: boolean; showMissing: boolean; missingPeriods: number; currentMonthUpdating: boolean }>): string {
  const { showError, error, showActive, showMissing, missingPeriods, currentMonthUpdating } = opts;
  if (showError) return `Sync error — ${error ?? ''}`;
  if (showActive) return 'Syncing…';
  if (showMissing) return `${String(missingPeriods)} billing period${missingPeriods === 1 ? '' : 's'} not synced`;
  if (currentMonthUpdating) return 'Current month has newer data to sync';
  return 'Data sync';
}

/** Pull the AWS profile out of an expired-credentials sync error so the popover
 *  can offer the same "Open SSO Login" action as the Data & Sync screen. The
 *  message is built as `… Run: aws sso login --profile <profile>`, so the
 *  profile is the trailing token; null for any non-credential error. */
function ssoLoginProfile(error: string | null): string | null {
  if (!error?.includes('aws sso login')) return null;
  return /--profile\s+(\S+)/.exec(error)?.[1] ?? null;
}

/** The GCP sister of `ssoLoginProfile`. `toUserFriendlyError` builds both
 *  provider messages the same way — `… Run: <command>` — so the command in the
 *  message is the marker.
 *
 *  BOTH commands are matched. GCP authenticates through two stores, and the
 *  stale-CLI-account error names `gcloud auth login`, which is not a substring
 *  of `gcloud auth application-default login` — so sniffing only for ADC left
 *  the one failure with a one-click remedy showing no button at all. Checked
 *  most-specific first: ADC's string contains neither the other's nor vice
 *  versa, but ordering it this way keeps the intent obvious. */
function gcloudLoginMode(error: string | null): 'adc' | 'cli' | null {
  if (error === null) return null;
  if (error.includes(GCLOUD_ADC_LOGIN_COMMAND)) return 'adc';
  if (error.includes(GCLOUD_CLI_LOGIN_COMMAND)) return 'cli';
  return null;
}

/** Dedicated data-sync indicator, split out of the Settings gear. Shows whether
 *  a download is in progress (and how many files remain), surfaces sync errors,
 *  and flags un-synced periods — with a per-tier breakdown on click, so the user
 *  doesn't have to open Settings › Data just to see activity. */
export function SyncStatusButton({
  activity, error, filesRemaining, missingPeriods, currentMonthUpdating, tiers, inSettingsData, onManageData, onRecheck,
}: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  // The live re-check, so a second caller can await the real work instead of
  // being handed an already-settled promise. `rechecking` drives the spinners;
  // this drives the joining.
  const recheckRef = useRef<Promise<void> | null>(null);
  const synced = missingPeriods === 0;

  // Returns the promise so the credential panel's Retry can await the same
  // re-check the header icon runs — one action, both spinners.
  //
  // A caller arriving while one is already in flight JOINS it rather than
  // getting a resolved promise back: returning `Promise.resolve()` made the
  // panel's Retry a silent no-op whenever the header icon was mid-check (the
  // icon is disabled then, the Retry is not), and the in-flight check had read
  // the pre-sign-in credentials, so it reported the same error the user had
  // just fixed.
  function handleRecheck(): Promise<void> {
    const running = recheckRef.current;
    if (running !== null) return running;
    setRechecking(true);
    const started = onRecheck().finally(() => {
      recheckRef.current = null;
      setRechecking(false);
    });
    recheckRef.current = started;
    return started;
  }

  const showError = error !== null;
  const ssoProfile = ssoLoginProfile(error);
  const gcloudMode = gcloudLoginMode(error);
  const showActive = !showError && activity !== 'idle';
  const showMissing = !showError && activity === 'idle' && missingPeriods > 0 && !inSettingsData;

  const title = buttonTitle({ showError, error, showActive, showMissing, missingPeriods, currentMonthUpdating });
  const periodPlural = missingPeriods === 1 ? '' : 's';
  const syncedFooter = currentMonthUpdating ? 'Current month updating' : 'All periods synced';
  const footerLabel = missingPeriods > 0
    ? `${String(missingPeriods)} period${periodPlural} not synced`
    : syncedFooter;

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
            onClick={() => { void handleRecheck(); }}
            disabled={rechecking}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            title="Check for new data"
            aria-label="Check for new data"
          >
            <RefreshCw size={13} className={rechecking ? 'animate-spin' : undefined} />
          </button>
        </div>
        {/* `break-words` below because this is the narrowest error surface in
            the app (w-72) and it receives raw provider strings — GCP's denials
            end in an IAM Troubleshooter URL with no break opportunity, which
            otherwise runs straight out of the popover. */}
        {showError && (
          <div className="mb-2 rounded-md border border-negative/50 bg-negative-muted px-2.5 py-1.5 text-xs text-negative break-words" role="alert">
            {error}
            {/* `onRetry` is the same re-check the header's refresh icon runs —
                it clears `syncError` on success, so a finished sign-in makes
                this whole panel disappear without leaving the popover. */}
            {ssoProfile !== null && (
              <SsoLoginButton profile={ssoProfile} onRetry={handleRecheck} />
            )}
            {gcloudMode !== null && (
              <GcloudLoginButton mode={gcloudMode} onRetry={handleRecheck} />
            )}
            {/* Sync errors are mostly NOT credential errors — a bare Retry so
                every one of them has a way forward from here. */}
            {ssoProfile === null && gcloudMode === null && (
              <div className="mt-2"><RetryButton onRetry={handleRecheck} /></div>
            )}
          </div>
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
