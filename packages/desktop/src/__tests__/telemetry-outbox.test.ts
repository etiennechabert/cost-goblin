import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryOutbox } from '../main/telemetry/outbox.js';
import type { TelemetryOutboxEntry } from '@costgoblin/core';

const OUTBOX_FILE = 'telemetry-outbox.jsonl';

function entry(i: number): TelemetryOutboxEntry {
  return { timestamp: '2026-01-01T00:00:00.000Z', eventId: `e${String(i)}`, level: 'error', kind: 'error', title: `t${String(i)}` };
}

/** Extract eventId from a JSONL line without unsafe `any` access. */
function eventIdOf(line: string): string | null {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec: Record<string, unknown> = { ...parsed };
  return typeof rec['eventId'] === 'string' ? rec['eventId'] : null;
}

async function readIds(file: string): Promise<Set<string>> {
  const raw = await readFile(file, 'utf-8');
  const ids = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map(eventIdOf)
    .filter((id): id is string => id !== null);
  return new Set(ids);
}

describe('TelemetryOutbox concurrency', () => {
  it('keeps every entry under a concurrent record() burst (no drop)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-outbox-'));
    try {
      const outbox = new TelemetryOutbox(dir);
      await Promise.all(Array.from({ length: 30 }, (_, i) => outbox.record(entry(i))));
      const ids = await readIds(join(dir, OUTBOX_FILE));
      expect(ids.size).toBe(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not clobber a pre-existing on-disk entry during a cold concurrent burst', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-outbox-'));
    const file = join(dir, OUTBOX_FILE);
    try {
      await writeFile(file, JSON.stringify(entry(999)) + '\n');
      // Fresh instance: its buffer isn't loaded yet, so the first records race
      // the file read — the exact window the fix closes.
      const outbox = new TelemetryOutbox(dir);
      await Promise.all(Array.from({ length: 20 }, (_, i) => outbox.record(entry(i))));
      const ids = await readIds(file);
      expect(ids.has('e999')).toBe(true);
      expect(ids.size).toBe(21);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves the crash kind across a reload (parseEntry round-trip)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-outbox-'));
    try {
      const crash: TelemetryOutboxEntry = {
        timestamp: '2026-01-01T00:00:00.000Z', eventId: 'c1', level: 'fatal', kind: 'crash',
        title: 'Native crash report (raw minidump sent)',
      };
      await new TelemetryOutbox(dir).record(crash);
      // A fresh instance reloads from disk through parseEntry — the kind must
      // survive rather than downgrade to 'other'.
      const reloaded = await new TelemetryOutbox(dir).list();
      expect(reloaded.find((e) => e.eventId === 'c1')?.kind).toBe('crash');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
