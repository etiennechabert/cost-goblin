import { useState } from 'react';
import type { DataInventoryResult } from '@costgoblin/core/browser';
import { ConfirmModal } from '../components/confirm-modal.js';

export type SyncState =
  | { status: 'idle' }
  | { status: 'downloading'; filesDone: number; filesTotal: number; message: string }
  | { status: 'repartitioning'; datesDone: number; datesTotal: number }
  | { status: 'done'; filesDownloaded: number }
  | { status: 'error'; message: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = Number(month) - 1;
  const monthName = months[monthIdx] ?? month;
  return `${monthName ?? ''} ${year ?? ''}`;
}

interface TierPanelProps {
  title: string;
  configured: boolean;
  bucket: string | null;
  retentionDays: number | null;
  localPeriods: readonly string[];
  diskBytes: number;
  oldestPeriod: string | null;
  newestPeriod: string | null;
  periods: DataInventoryResult['periods'];
  selected: Set<string>;
  onToggle: (period: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDownload: () => void;
  onDeletePeriod: (period: string) => void;
  syncState: SyncState;
  onConfigure?: (() => void) | undefined;
  onCancelSync?: (() => void) | undefined;
}

export function TierPanel({
  title, configured, bucket, retentionDays,
  localPeriods, diskBytes, oldestPeriod, newestPeriod,
  periods, selected, onToggle, onSelectAll, onDeselectAll, onDownload, onDeletePeriod,
  syncState, onConfigure, onCancelSync,
}: Readonly<TierPanelProps>) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const missingPeriods = periods.filter(p => p.localStatus === 'missing' || p.localStatus === 'stale');
  const downloadedPeriods = periods.filter(p => p.localStatus === 'repartitioned');
  const selectedFiles = periods.filter(p => selected.has(p.period)).flatMap(p => [...p.files]);
  const selectedSize = selectedFiles.reduce((s, f) => s + f.size, 0);
  const isSyncing = syncState.status === 'downloading' || syncState.status === 'repartitioning';

  if (!configured) {
    return (
      <div className="flex-1 rounded-xl border border-border bg-bg-secondary/30 p-5">
        <h3 className="text-sm font-semibold text-text-primary mb-4">{title}</h3>
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-text-secondary">Not configured</p>
          {onConfigure !== undefined ? (
            <button
              type="button"
              onClick={onConfigure}
              className="mt-3 rounded-md border border-accent/50 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
            >
              Configure {title.toLowerCase()} data source
            </button>
          ) : (
            <p className="text-xs text-text-muted mt-2">
              Add a <span className="font-mono text-text-secondary">{title.toLowerCase()}</span> section to your provider sync config in <span className="font-mono text-accent">costgoblin.yaml</span>
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 rounded-xl border border-border bg-bg-secondary/30 p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {onConfigure !== undefined && (
          <button type="button" onClick={onConfigure} className="text-text-muted hover:text-text-secondary transition-colors" title={`Configure ${title.toLowerCase()}`}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        )}
      </div>

      {/* Config */}
      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-text-muted">S3 Bucket</span>
          <span className="text-text-secondary font-mono truncate max-w-48 ml-2" title={bucket ?? ''}>{bucket ?? '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Retention</span>
          <span className="text-text-secondary tabular-nums">{retentionDays === null ? '—' : `${String(retentionDays)} days`}</span>
        </div>
      </div>

      {/* Local stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
          <p className="text-xs text-text-muted">Local</p>
          <p className="text-lg font-bold tabular-nums text-accent">{String(localPeriods.length)} <span className="text-xs font-normal text-text-muted">months</span></p>
          <p className="text-xs text-text-muted tabular-nums">{formatBytes(diskBytes)}</p>
        </div>
        <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
          <p className="text-xs text-text-muted">Range</p>
          <p className="text-xs font-medium text-text-primary mt-1">{oldestPeriod ?? '—'}</p>
          <p className="text-xs text-text-muted">{newestPeriod !== null ? `to ${newestPeriod}` : ''}</p>
        </div>
      </div>

      {/* Sync progress */}
      {syncState.status === 'downloading' && (
        <div className="rounded-lg border border-accent/50 bg-positive-muted px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2 text-xs text-accent min-w-0">
              <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse shrink-0" />
              <span>Downloading {String(syncState.filesDone)}/{String(syncState.filesTotal)} files</span>
            </div>
            <button
              type="button"
              onClick={() => { onCancelSync?.(); }}
              className="p-0.5 rounded text-negative/70 hover:text-negative hover:bg-negative-muted transition-colors shrink-0 ml-2"
              title="Cancel download"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M1 1l10 10M11 1L1 11" />
              </svg>
            </button>
          </div>
          <div className="h-1 rounded-full bg-bg-tertiary overflow-hidden mb-1.5">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${String(syncState.filesTotal > 0 ? Math.round(syncState.filesDone / syncState.filesTotal * 100) : 0)}%` }} />
          </div>
          {syncState.message.length > 0 && (
            <p className="text-[10px] text-text-muted font-mono truncate">{syncState.message}</p>
          )}
        </div>
      )}
      {syncState.status === 'repartitioning' && (
        <div className="rounded-lg border border-violet-500/50 bg-violet-500/5 px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 text-xs text-violet-400">
              <div className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
              <span>Processing — repartitioning into daily partitions</span>
            </div>
            <span className="text-[10px] text-text-muted tabular-nums">
              {String(syncState.datesDone)} / {String(syncState.datesTotal)} days
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
            <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${String(syncState.datesTotal > 0 ? Math.round(syncState.datesDone / syncState.datesTotal * 100) : 0)}%` }} />
          </div>
        </div>
      )}
      {syncState.status === 'done' && (
        <div className="rounded-lg border border-accent/50 bg-positive-muted px-3 py-2 text-xs text-accent">
          Synced {String(syncState.filesDownloaded)} files
        </div>
      )}
      {syncState.status === 'error' && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2 text-xs text-negative">
          {syncState.message}
        </div>
      )}

      {/* Missing / stale periods */}
      {missingPeriods.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-text-secondary">Available</span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={onSelectAll} className="text-[11px] text-text-muted hover:text-text-primary">All</button>
              <span className="text-border">·</span>
              <button type="button" onClick={onDeselectAll} className="text-[11px] text-text-muted hover:text-text-primary">None</button>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-border-subtle">
            {missingPeriods.map(p => (
              <label key={p.period} className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-tertiary/30 cursor-pointer text-xs">
                <input type="checkbox" checked={selected.has(p.period)} onChange={() => { onToggle(p.period); }} className="h-3.5 w-3.5 rounded accent-emerald-500" />
                <span className="text-text-primary w-16">{formatPeriod(p.period)}</span>
                {p.localStatus === 'stale' && (
                  <span className="rounded bg-warning-muted px-1.5 py-0.5 text-[10px] font-medium text-warning">stale</span>
                )}
                <span className="text-text-muted tabular-nums ml-auto">{formatBytes(p.totalSize)}</span>
              </label>
            ))}
          </div>
          {selected.size > 0 && (
            <div className="border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={onDownload}
                disabled={isSyncing}
                className="w-full rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Download {String(selected.size)} ({formatBytes(selectedSize)})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Local periods */}
      {downloadedPeriods.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-text-secondary">Downloaded</span>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-border-subtle">
            {downloadedPeriods.map(p => (
              <div key={p.period} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <div className="h-1.5 w-1.5 rounded-full bg-accent" />
                <span className="text-text-primary w-16">{formatPeriod(p.period)}</span>
                <span className="text-text-muted tabular-nums ml-auto mr-2">{formatBytes(p.totalSize)}</span>
                <button type="button" onClick={() => { setPendingDelete(p.period); }} className="text-text-muted hover:text-negative transition-colors">
                  &#10005;
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {missingPeriods.length === 0 && downloadedPeriods.length === 0 && (
        <div className="text-xs text-text-muted text-center py-4">No data found in S3</div>
      )}

      {pendingDelete !== null && (
        <ConfirmModal
          title="Delete local data"
          message={`Remove all local daily partitions for ${formatPeriod(pendingDelete)}? The data can be re-downloaded from S3.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => { onDeletePeriod(pendingDelete); setPendingDelete(null); }}
          onCancel={() => { setPendingDelete(null); }}
        />
      )}
    </div>
  );
}
