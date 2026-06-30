import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readSyncTimestamps, readTierLastSync, writeTierLastSync } from '../sync/sync-timestamps.js';

describe('sync-timestamps persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `costgoblin-ts-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns null for a tier with no recorded timestamp', async () => {
    expect(await readTierLastSync(tempDir, 'daily')).toBeNull();
    expect(await readSyncTimestamps(tempDir)).toEqual({});
  });

  it('round-trips a written timestamp', async () => {
    await writeTierLastSync(tempDir, 'daily', '2026-06-26T10:00:00.000Z');
    expect(await readTierLastSync(tempDir, 'daily')).toBe('2026-06-26T10:00:00.000Z');
  });

  it('preserves other tiers when writing one', async () => {
    await writeTierLastSync(tempDir, 'daily', '2026-06-01T00:00:00.000Z');
    await writeTierLastSync(tempDir, 'hourly', '2026-06-02T00:00:00.000Z');
    expect(await readTierLastSync(tempDir, 'daily')).toBe('2026-06-01T00:00:00.000Z');
    expect(await readTierLastSync(tempDir, 'hourly')).toBe('2026-06-02T00:00:00.000Z');
  });

  it('overwrites the timestamp for the same tier', async () => {
    await writeTierLastSync(tempDir, 'daily', '2026-06-01T00:00:00.000Z');
    await writeTierLastSync(tempDir, 'daily', '2026-06-26T12:00:00.000Z');
    expect(await readTierLastSync(tempDir, 'daily')).toBe('2026-06-26T12:00:00.000Z');
  });

  it('ignores corrupt JSON and non-string values', async () => {
    await writeFile(join(tempDir, 'sync-timestamps.json'), '{ not valid json');
    expect(await readSyncTimestamps(tempDir)).toEqual({});

    await writeFile(
      join(tempDir, 'sync-timestamps.json'),
      JSON.stringify({ daily: 123, hourly: '2026-06-02T00:00:00.000Z' }),
    );
    expect(await readSyncTimestamps(tempDir)).toEqual({ hourly: '2026-06-02T00:00:00.000Z' });
  });
});
