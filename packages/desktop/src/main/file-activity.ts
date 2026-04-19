/**
 * Rolling log of file-level sync/optimize transitions. Lives in memory; the
 * UI's "Recent file activity" panel pulls from it via IPC. Lost across app
 * restarts — the current on-disk stage is always re-derivable from file
 * presence + mtimes, so we don't need durable state.
 */

export type FileStage =
  | 'downloaded'
  | 'sorting'
  | 'sorted'
  | 'building-sidecar'
  | 'complete'
  | 'failed';

export interface FileActivityEvent {
  readonly timestamp: string;        // ISO
  readonly rawPath: string;          // full path on disk
  readonly relName: string;          // 'daily-2026-04/cur-00001.parquet' for display
  readonly stage: FileStage;
  readonly tagKey?: string | undefined;      // when stage is 'building-sidecar'
  readonly durationMs?: number | undefined;  // on stage completion
  readonly error?: string | undefined;       // when stage is 'failed'
}

/**
 * Ring buffer. Size bounds memory footprint and ensures the activity feed
 * stays snappy to read.
 */
export class FileActivityLog {
  private readonly events: FileActivityEvent[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  record(event: Omit<FileActivityEvent, 'timestamp'>): void {
    const full: FileActivityEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.events.push(full);
    if (this.events.length > this.maxEntries) {
      this.events.splice(0, this.events.length - this.maxEntries);
    }
  }

  /** Returns events since (exclusive) a given ISO timestamp. Used for polling. */
  since(isoTimestamp?: string): FileActivityEvent[] {
    if (isoTimestamp === undefined) return [...this.events];
    return this.events.filter(e => e.timestamp > isoTimestamp);
  }

  all(): readonly FileActivityEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }

  /** Drop events whose rawPath matches the predicate (e.g. after deleting a period). */
  removeWhere(predicate: (rawPath: string) => boolean): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev !== undefined && predicate(ev.rawPath)) this.events.splice(i, 1);
    }
  }
}
