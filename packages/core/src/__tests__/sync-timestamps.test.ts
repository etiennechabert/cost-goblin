import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readSyncTimestamps, readTierLastSync, writeTierLastSync } from '../sync/sync-timestamps.js';
import { asProviderName } from '../types/branded.js';

const provider = asProviderName('aws');

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
    expect(await readTierLastSync(tempDir, provider, 'daily')).toBeNull();
    expect(await readSyncTimestamps(tempDir, provider)).toEqual({});
  });

  it('round-trips a written timestamp', async () => {
    await writeTierLastSync(tempDir, provider, 'daily', '2026-06-26T10:00:00.000Z');
    expect(await readTierLastSync(tempDir, provider, 'daily')).toBe('2026-06-26T10:00:00.000Z');
  });

  it('preserves other tiers when writing one', async () => {
    await writeTierLastSync(tempDir, provider, 'daily', '2026-06-01T00:00:00.000Z');
    await writeTierLastSync(tempDir, provider, 'hourly', '2026-06-02T00:00:00.000Z');
    expect(await readTierLastSync(tempDir, provider, 'daily')).toBe('2026-06-01T00:00:00.000Z');
    expect(await readTierLastSync(tempDir, provider, 'hourly')).toBe('2026-06-02T00:00:00.000Z');
  });

  it('overwrites the timestamp for the same tier', async () => {
    await writeTierLastSync(tempDir, provider, 'daily', '2026-06-01T00:00:00.000Z');
    await writeTierLastSync(tempDir, provider, 'daily', '2026-06-26T12:00:00.000Z');
    expect(await readTierLastSync(tempDir, provider, 'daily')).toBe('2026-06-26T12:00:00.000Z');
  });

  it('writes the timestamps file under the provider meta dir', async () => {
    await writeTierLastSync(tempDir, provider, 'daily', '2026-06-26T10:00:00.000Z');
    const raw = await readFile(join(tempDir, 'aws', 'meta', 'sync-timestamps.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ daily: '2026-06-26T10:00:00.000Z' });
  });

  it('ignores corrupt JSON and non-string values', async () => {
    const metaDir = join(tempDir, 'aws', 'meta');
    await mkdir(metaDir, { recursive: true });
    await writeFile(join(metaDir, 'sync-timestamps.json'), '{ not valid json');
    expect(await readSyncTimestamps(tempDir, provider)).toEqual({});

    await writeFile(
      join(metaDir, 'sync-timestamps.json'),
      JSON.stringify({ daily: 123, hourly: '2026-06-02T00:00:00.000Z' }),
    );
    expect(await readSyncTimestamps(tempDir, provider)).toEqual({ hourly: '2026-06-02T00:00:00.000Z' });
  });
});
