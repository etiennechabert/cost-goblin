import type { SyncStatus } from '@costgoblin/core/browser';

interface SyncStatusProps {
  status: SyncStatus;
  onSync: () => void;
}

function formatLastSync(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${String(diffMins)}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${String(diffHours)}h ago`;
  return date.toLocaleDateString();
}

export function SyncStatusIndicator({ status, onSync }: Readonly<SyncStatusProps>) {
  return (
    <div className="flex items-center gap-3">
      {status.status === 'idle' && (
        <span className="text-xs text-text-secondary">
          {status.lastSync === null
            ? 'Not synced'
            : `Last sync: ${formatLastSync(status.lastSync)}`}
        </span>
      )}

      {status.status === 'syncing' && (
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-accent animate-pulse" />
          <span className="text-xs text-text-secondary">
            Syncing... {String(status.filesDone)}/{String(status.filesTotal)}
          </span>
        </div>
      )}

      {status.status === 'completed' && (
        <span className="text-xs text-accent">
          Synced {String(status.filesDownloaded)} files
        </span>
      )}

      {status.status === 'failed' && (
        <span className="text-xs text-negative" title={status.error.message}>
          Sync failed
        </span>
      )}

      <button
        type="button"
        onClick={onSync}
        disabled={status.status === 'syncing'}
        className="rounded-md border border-border bg-bg-tertiary/50 px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {status.status === 'syncing' ? 'Syncing...' : 'Sync Now'}
      </button>
    </div>
  );
}
