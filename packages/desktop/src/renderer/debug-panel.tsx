import { useState, useEffect, useCallback } from 'react';

const debug = globalThis.costgoblinDebug;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function serializeLog(entries: DebugQueryLogEntry[]): string {
  return entries.map(e => {
    const labels: Record<string, string> = { queued: 'QUE', running: 'RUN', success: 'OK', error: 'ERR' };
    const status = labels[e.status] ?? e.status;
    const duration = e.durationMs !== null ? formatDuration(e.durationMs) : '...';
    const rows = e.rowCount !== null ? `${String(e.rowCount)} rows` : '';
    const header = `[${status}] ${formatTimestamp(e.startedAt)}  ${duration}  ${rows}`;
    const error = e.error !== null ? `\nError: ${e.error}` : '';
    return `${header}\n${e.sql}${error}`;
  }).join('\n\n---\n\n');
}

function sqlPreview(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine;
}

function StatusDot({ status }: { status: DebugQueryLogEntry['status'] }): React.JSX.Element {
  if (status === 'running') {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent animate-pulse" />;
  }
  if (status === 'queued') {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-warning animate-pulse" />;
  }
  if (status === 'error') {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-negative" />;
  }
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-positive" />;
}

function QueryRow({ entry }: { entry: DebugQueryLogEntry }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [explainResult, setExplainResult] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);

  const handleExplain = useCallback(() => {
    setExplainLoading(true);
    void debug.runExplain(entry.id).then((result) => {
      setExplainResult(result);
      setExplainLoading(false);
    });
  }, [entry.id]);

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => { setExpanded(!expanded); }}
        className="w-full text-left px-3 py-2 hover:bg-bg-tertiary/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <StatusDot status={entry.status} />
          <span className="flex-1 text-xs font-mono text-text-secondary truncate">
            {sqlPreview(entry.sql)}
          </span>
          <span className="text-xs text-text-muted shrink-0">
            {entry.durationMs !== null ? formatDuration(entry.durationMs) : entry.status === 'queued' ? 'queued' : '...'}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-0.5 ml-4">
          <span className="text-[10px] text-text-muted">{formatTimestamp(entry.startedAt)}</span>
          {entry.rowCount !== null && (
            <span className="text-[10px] text-text-muted">{String(entry.rowCount)} rows</span>
          )}
          {entry.paramCount > 0 && (
            <span className="text-[10px] text-text-muted">{String(entry.paramCount)} params</span>
          )}
          {entry.error !== null && (
            <span className="text-[10px] text-negative truncate">{entry.error}</span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <pre className="text-[11px] font-mono text-text-secondary bg-bg-primary rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
            {entry.sql}
          </pre>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExplain}
              disabled={explainLoading || entry.status === 'running' || entry.status === 'queued'}
              className="text-[11px] px-2 py-0.5 rounded bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors disabled:opacity-40"
            >
              {explainLoading ? 'Running...' : 'EXPLAIN ANALYZE'}
            </button>
          </div>
          {explainResult !== null && (
            <pre className="text-[11px] font-mono text-text-secondary bg-bg-primary rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
              {explainResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function DebugPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<DebugQueryLogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    function poll(): void {
      void debug.getQueryLog().then((log) => {
        if (!cancelled) setEntries(log);
      });
    }
    poll();
    const timer = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const runningCount = entries.filter(e => e.status === 'running').length;
  const queuedCount = entries.filter(e => e.status === 'queued').length;
  const reversed = [...entries].reverse();

  return (
    <div className="fixed top-[4.5rem] right-0 bottom-0 z-40 w-[75vw] bg-bg-secondary border-l border-border shadow-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 [-webkit-app-region:no-drag]">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text-primary">Query Log</h2>
          <span className="text-xs text-text-muted">
            {String(entries.length)} queries
            {(runningCount > 0 || queuedCount > 0) && (
              <span className="ml-1">
                {runningCount > 0 && <span className="text-accent">{String(runningCount)} running</span>}
                {runningCount > 0 && queuedCount > 0 && <span className="text-text-muted">, </span>}
                {queuedCount > 0 && <span className="text-warning">{String(queuedCount)} queued</span>}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void navigator.clipboard.writeText(serializeLog(entries)); }}
            className="text-xs px-2 py-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([serializeLog(entries)], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `query-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="text-xs px-2 py-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            Export
          </button>
          <button
            type="button"
            onClick={() => { void debug.clearLog().then(() => { setEntries([]); }); }}
            className="text-xs px-2 py-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Query list */}
      <div className="flex-1 overflow-y-auto">
        {reversed.length === 0 && (
          <p className="text-xs text-text-muted text-center py-8">No queries yet</p>
        )}
        {reversed.map(entry => (
          <QueryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

export function useDebugBadge(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCount(debug.getInFlightCount());
    }, 300);
    return () => { clearInterval(timer); };
  }, []);

  return count;
}
