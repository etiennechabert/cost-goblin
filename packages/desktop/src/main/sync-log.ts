import type { SyncLogLine, SyncLogLevel } from '@costgoblin/core';

// Live, ephemeral sync/S3 activity log. A bounded ring buffer in the main
// process, fed by the sync worker's forwarded log lines (the `[aws] …`
// transfer detail) plus the main-process orchestration breadcrumbs (auto-sync,
// prune). The Data & Sync screen reads the backlog on mount and subscribes for
// pushed appends — mirrors the update-manager log buffer, just larger because a
// sync is verbose. Not persisted: cleared on restart.

const LIMIT = 1000;

const buffer: SyncLogLine[] = [];
let seq = 0;

type Listener = (line: SyncLogLine) => void;
const listeners = new Set<Listener>();

export function recordSyncLog(level: SyncLogLevel, message: string, ts: number = Date.now()): void {
  const line: SyncLogLine = { seq: seq++, ts, level, message };
  buffer.push(line);
  if (buffer.length > LIMIT) {
    buffer.splice(0, buffer.length - LIMIT);
  }
  for (const listener of listeners) {
    listener(line);
  }
}

export function snapshotSyncLog(): readonly SyncLogLine[] {
  return buffer.slice();
}

export function clearSyncLog(): void {
  buffer.length = 0;
}

export function onSyncLogAppend(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
