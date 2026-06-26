import { join } from 'node:path';
import { logger } from '@costgoblin/core';
import type { TelemetryOutboxEntry } from '@costgoblin/core';

const OUTBOX_FILE = 'telemetry-outbox.jsonl';
const MAX_ENTRIES = 500;

function parseEntry(line: string): TelemetryOutboxEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec: Record<string, unknown> = { ...parsed };
  const timestamp = rec['timestamp'];
  const title = rec['title'];
  if (typeof timestamp !== 'string' || typeof title !== 'string') return null;
  const kind = rec['kind'];
  return {
    timestamp,
    title,
    eventId: typeof rec['eventId'] === 'string' ? rec['eventId'] : null,
    level: typeof rec['level'] === 'string' ? rec['level'] : null,
    kind: kind === 'error' || kind === 'transaction' || kind === 'session' ? kind : 'other',
  };
}

/**
 * Append-only local audit log of telemetry events. Every event handed to the
 * Sentry transport is mirrored here (post-scrub) so the user can open Settings →
 * Telemetry and verify exactly what left the machine. Bounded to the most recent
 * {@link MAX_ENTRIES} lines; persisted as JSONL next to ui-preferences.json.
 */
export class TelemetryOutbox {
  private readonly path: string;
  private buffer: TelemetryOutboxEntry[] = [];
  private loaded = false;

  constructor(dir: string) {
    this.path = join(dir, OUTBOX_FILE);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(this.path, 'utf-8');
      this.buffer = raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map(parseEntry)
        .filter((e): e is TelemetryOutboxEntry => e !== null)
        .slice(-MAX_ENTRIES);
    } catch {
      this.buffer = [];
    }
  }

  /** Append one entry (most-recent kept) and persist. Never throws — auditing
   *  must not be able to crash the reporter. */
  async record(entry: TelemetryOutboxEntry): Promise<void> {
    try {
      await this.ensureLoaded();
      this.buffer.push(entry);
      if (this.buffer.length > MAX_ENTRIES) this.buffer = this.buffer.slice(-MAX_ENTRIES);
      const fs = await import('node:fs/promises');
      await fs.writeFile(this.path, this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch (err: unknown) {
      logger.warn(`telemetry-outbox: failed to record — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Most-recent-first snapshot for the settings UI. */
  async list(): Promise<readonly TelemetryOutboxEntry[]> {
    await this.ensureLoaded();
    return [...this.buffer].reverse();
  }
}
