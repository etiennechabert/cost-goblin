import type { DataSharingStatus } from '@costgoblin/core/browser';
import { Network, Square } from 'lucide-react';
import { formatBytes } from './format.js';

/** App-wide banner shown while this machine is sharing its data on the LAN.
 *  Surfaces live activity (connected peers, files + bytes served, throughput)
 *  and a one-click Stop. Purely presentational — the parent owns the status
 *  poll and the disable action. */
export function SharingActiveBanner({ status, onStop, stopping = false }: Readonly<{
  status: DataSharingStatus;
  onStop: () => void;
  stopping?: boolean;
}>): React.JSX.Element {
  const live = status.connectedClients > 0;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-accent/30 bg-accent/10 px-4 py-1.5 [-webkit-app-region:no-drag]">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`relative inline-flex h-2 w-2 shrink-0 rounded-full ${live ? 'bg-positive' : 'bg-accent'}`}>
          {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive opacity-75" aria-hidden="true" />}
        </span>
        <Network size={15} className="shrink-0 text-accent" />
        <span className="shrink-0 text-sm font-medium text-text-primary">Sharing your data</span>
        <span className="truncate text-xs text-text-muted">· {status.label}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-text-secondary sm:gap-4">
        <span>{status.connectedClients} connected</span>
        <span className="hidden md:inline">
          {status.filesServed} file{status.filesServed === 1 ? '' : 's'} · {formatBytes(status.bytesServed)}
        </span>
        {status.bytesPerSecond > 0 && (
          <span className="font-medium text-accent">{formatBytes(status.bytesPerSecond)}/s</span>
        )}
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="inline-flex items-center gap-1.5 rounded-md bg-bg-tertiary px-2.5 py-1 font-medium text-text-primary transition-colors hover:bg-bg-tertiary/70 disabled:opacity-50"
        >
          <Square size={11} className="fill-current" />
          {stopping ? 'Stopping…' : 'Stop sharing'}
        </button>
      </div>
    </div>
  );
}
