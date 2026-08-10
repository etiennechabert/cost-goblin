import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SyncLogLine, SyncLogLevel } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';

const MAX_LINES = 1000;

type LevelFilter = 'all' | 'warn' | 'error';

const FILTER_LABELS: Readonly<Record<LevelFilter, string>> = { all: 'All', warn: 'Warnings', error: 'Errors' };

function levelClass(level: SyncLogLevel): string {
  switch (level) {
    case 'error': return 'text-negative';
    case 'warn': return 'text-warning';
    case 'debug': return 'text-text-muted';
    default: return 'text-text-secondary';
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

/** Expandable terminal-style tail of the live sync/S3 activity log. Reads the
 *  main-process ring-buffer backlog on mount and subscribes for pushed appends
 *  (no polling). Collapsible via the same chevron-disclosure pattern as the org
 *  / region sections. `active` drives the live dot while a sync is in flight. */
export function SyncLogPanel({ active = false }: { active?: boolean }) {
  const api = useCostApi();
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState<readonly SyncLogLine[]>([]);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [copied, setCopied] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  const addLines = useCallback((incoming: readonly SyncLogLine[]) => {
    if (incoming.length === 0) return;
    setLines(prev => {
      const last = prev.at(-1);
      const lastSeq = last === undefined ? -1 : last.seq;
      let next: SyncLogLine[];
      if (incoming.every(l => l.seq > lastSeq)) {
        // Steady state: pushed lines arrive in monotonic seq order, so a plain
        // append keeps everything sorted with no dedup/re-sort work.
        next = [...prev, ...incoming];
      } else {
        // One-time mount race (backlog vs an early push overlap on seq): dedup
        // by seq and re-sort. seq is monotonic, so sorting restores order.
        const bySeq = new Map<number, SyncLogLine>();
        for (const l of prev) bySeq.set(l.seq, l);
        for (const l of incoming) bySeq.set(l.seq, l);
        next = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      }
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    // Subscribe before fetching the backlog so no line emitted in between is
    // lost (dedup reconciles any overlap).
    const unsubscribe = api.subscribeSyncLog(line => { addLines([line]); });
    api.getSyncLog().then(backlog => { addLines(backlog); }).catch(() => undefined);
    return unsubscribe;
  }, [api, addLines]);

  const filtered = useMemo(() => {
    if (filter === 'all') return lines;
    if (filter === 'error') return lines.filter(l => l.level === 'error');
    return lines.filter(l => l.level === 'warn' || l.level === 'error');
  }, [lines, filter]);

  useEffect(() => {
    if (!expanded) return;
    const el = scrollRef.current;
    if (el !== null && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filtered, expanded]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const handleCopy = () => {
    const text = filtered.map(l => `${formatTime(l.ts)} ${l.message}`).join('\n');
    void navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true);
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => { setCopied(false); }, 1500);
      })
      .catch(() => undefined);
  };

  const handleClear = () => {
    void api.clearSyncLog().catch(() => undefined);
    setLines([]);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => { setExpanded(v => !v); }}
          className="flex items-center gap-2 flex-1 text-left hover:bg-bg-tertiary/30 transition-colors rounded -mx-1 px-1"
        >
          <div className={`h-2 w-2 rounded-full ${active ? 'bg-accent animate-pulse' : 'bg-text-muted/40'}`} />
          <span className="text-sm font-medium text-text-primary">Activity log</span>
          {lines.length > 0 && <span className="text-text-muted text-xs">({String(lines.length)})</span>}
          <span className="text-text-muted ml-auto text-xs">{expanded ? '▾' : '▸'}</span>
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border">
          <div className="flex items-center gap-2 px-4 py-2 text-xs">
            <div className="flex items-center gap-1">
              {(['all', 'warn', 'error'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => { setFilter(f); }}
                  className={`rounded px-2 py-0.5 transition-colors ${filter === f ? 'bg-bg-tertiary text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
                >
                  {FILTER_LABELS[f]}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopy}
                disabled={filtered.length === 0}
                className="rounded px-2 py-0.5 text-text-muted hover:text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={lines.length === 0}
                className="rounded px-2 py-0.5 text-text-muted hover:text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Clear
              </button>
            </div>
          </div>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="max-h-64 overflow-y-auto bg-bg-primary/40 px-4 py-2 font-mono text-[10px] leading-relaxed"
          >
            {filtered.length === 0 ? (
              <p className="text-text-muted py-2">No sync activity yet — logs stream here while data syncs from S3.</p>
            ) : (
              filtered.map(l => (
                <div key={l.seq} className="whitespace-pre-wrap break-all">
                  <span className="text-text-muted">{formatTime(l.ts)}</span>{' '}
                  <span className={levelClass(l.level)}>{l.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
