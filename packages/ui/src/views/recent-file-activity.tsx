import { useEffect, useState } from 'react';
import type { FileActivityEvent, FileActivityStage, OptimizeStatus } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { ConfirmModal } from '../components/confirm-modal.js';

type FilterMode = 'active' | 'all' | 'failed';

function formatRelative(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 1000) return 'now';
  if (diff < 60_000) return `${String(Math.floor(diff / 1000))}s`;
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))}m`;
  if (diff < 86_400_000) return `${String(Math.floor(diff / 3_600_000))}h`;
  return `${String(Math.floor(diff / 86_400_000))}d`;
}

function stageLabel(ev: FileActivityEvent): string {
  switch (ev.stage) {
    case 'downloaded': return 'downloaded';
    case 'sorting': return 'sorting';
    case 'sorted': return 'sorted';
    case 'building-sidecar': return 'building sidecar';
    case 'complete': return 'optimized';
    case 'failed': return 'failed';
  }
}

function stageColor(stage: FileActivityStage): string {
  switch (stage) {
    case 'complete': return 'text-accent';
    case 'failed': return 'text-negative';
    case 'downloaded': return 'text-text-secondary';
    case 'sorting':
    case 'building-sidecar':
      return 'text-warning';
    case 'sorted': return 'text-text-secondary';
  }
}

function stageDot(stage: FileActivityStage): string {
  switch (stage) {
    case 'complete': return 'bg-accent';
    case 'failed': return 'bg-negative';
    case 'sorting':
    case 'building-sidecar':
      return 'bg-warning animate-pulse';
    default:
      return 'bg-text-muted';
  }
}

function latestPerFile(events: readonly FileActivityEvent[]): FileActivityEvent[] {
  const byPath = new Map<string, FileActivityEvent>();
  for (const e of events) {
    const prev = byPath.get(e.rawPath);
    if (prev === undefined || e.timestamp >= prev.timestamp) byPath.set(e.rawPath, e);
  }
  return [...byPath.values()].sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
}

export function RecentFileActivity() {
  const api = useCostApi();
  const [events, setEvents] = useState<FileActivityEvent[]>([]);
  const [status, setStatus] = useState<OptimizeStatus>({ queued: 0, running: false });
  const [enabled, setEnabled] = useState(true);
  const [enabledLoaded, setEnabledLoaded] = useState(false);
  const [filter, setFilter] = useState<FilterMode>('active');
  const [now, setNow] = useState(Date.now());
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    void api.getOptimizeEnabled().then(v => { setEnabled(v); setEnabledLoaded(true); });
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const [ev, s] = await Promise.all([api.getFileActivity(), api.getOptimizeStatus()]);
        if (!cancelled) {
          setEvents(ev);
          setStatus(s);
          setNow(Date.now());
        }
      } catch { /* polling failure is transient */ }
    }
    void tick();
    const timer = setInterval(() => { void tick(); }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  function toggleEnabled(): void {
    const next = !enabled;
    setEnabled(next);
    void api.setOptimizeEnabled(next);
  }

  function handleClearSidecars(): void {
    setClearing(true);
    setConfirmClear(false);
    void api.clearSidecars().finally(() => { setClearing(false); });
  }

  const latest = latestPerFile(events);
  const filtered = latest.filter(e => {
    if (filter === 'failed') return e.stage === 'failed';
    if (filter === 'active') return e.stage !== 'complete' && e.stage !== 'failed';
    return true;
  });

  const stateLine = !enabled
    ? (status.running ? `Pausing — ${String(status.queued)} queued, finishing current file…` : `Paused · ${String(status.queued)} queued`)
    : status.queued > 0 || status.running
      ? `${String(status.queued)} queued${status.running ? ' · optimizer running' : ''}`
      : 'Optimizer idle';

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">Local optimizer</h3>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">
            Sorts each raw Parquet by date so narrow date-range queries can skip most of the file
            (row-group pruning), and builds a single combined sidecar holding all tag dimensions
            as flat columns — faster than the per-row <code className="font-mono text-[10px] px-1 rounded bg-bg-tertiary/50">element_at</code> map
            lookup for long-range queries. Regenerates automatically on re-sync or when you change Dimensions.
          </p>
          <p className="text-xs text-text-muted mt-1">{stateLine}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => { setConfirmClear(true); }}
            disabled={clearing || status.running}
            title={status.running ? 'Pause the optimizer first.' : 'Delete generated sidecars and rebuild them from scratch.'}
            className="rounded-md border border-border bg-bg-tertiary/30 px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {clearing ? 'Clearing…' : 'Clear sidecars'}
          </button>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="text-xs text-text-secondary">{enabled ? 'Enabled' : 'Paused'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={toggleEnabled}
              disabled={!enabledLoaded}
              className={[
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border',
              ].join(' ')}
            >
              <span
                className={[
                  'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                  enabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
                ].join(' ')}
              />
            </button>
          </label>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
            {(['active', 'failed', 'all'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => { setFilter(m); }}
                className={[
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors capitalize',
                  filter === m
                    ? 'bg-bg-secondary text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 && (
        <p className="text-xs text-text-muted py-6 text-center">
          {filter === 'failed'
            ? 'No failed files.'
            : filter === 'active'
              ? 'Nothing in flight.'
              : 'No activity yet.'}
        </p>
      )}

      {filtered.length > 0 && (
        <div className="max-h-64 overflow-y-auto divide-y divide-border-subtle">
          {filtered.map(ev => (
            <div key={ev.rawPath + ev.timestamp} className="flex items-center gap-3 py-2 text-xs">
              <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${stageDot(ev.stage)}`} />
              <span className="text-text-secondary font-mono truncate flex-1" title={ev.rawPath}>
                {ev.relName}
              </span>
              <span className={`${stageColor(ev.stage)} shrink-0`}>{stageLabel(ev)}</span>
              {ev.durationMs !== undefined && (
                <span className="text-text-muted tabular-nums shrink-0">{String(ev.durationMs)}ms</span>
              )}
              {ev.error !== undefined && (
                <span className="text-negative truncate max-w-64" title={ev.error}>{ev.error}</span>
              )}
              <span className="text-text-muted tabular-nums shrink-0 w-8 text-right">
                {formatRelative(ev.timestamp, now)}
              </span>
            </div>
          ))}
        </div>
      )}

      {confirmClear && (
        <ConfirmModal
          title="Clear sidecars"
          message="Delete every generated sidecar Parquet and rebuild from the raw files. Raw data and sort markers are kept — this only wipes the pre-computed tag columns. Takes a few seconds per file."
          confirmLabel="Clear and rebuild"
          onConfirm={handleClearSidecars}
          onCancel={() => { setConfirmClear(false); }}
        />
      )}
    </div>
  );
}
