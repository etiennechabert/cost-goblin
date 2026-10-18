import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSyncTimestamps, readTierLastSync, writeTierLastSync } from '../sync/sync-timestamps.js';
import { asProviderName } from '../types/branded.js';

/** A `sync-timestamps.json` that parses but is not a tier → timestamp map —
 *  hand-edited, or written by something else — must read as "never synced",
 *  never as a crash or as garbage tiers, and the next successful sync must
 *  replace it with a well-formed map. */

const provider = asProviderName('aws-main');

describe('a sync-timestamps file that is valid JSON but not an object', () => {
  let dataDir: string;
  let filePath: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'sync-ts-malformed-'));
    const metaDir = join(dataDir, String(provider), 'meta');
    await mkdir(metaDir, { recursive: true });
    filePath = join(metaDir, 'sync-timestamps.json');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    ['an array', '["daily", "2026-06-01T00:00:00.000Z"]'],
    ['a string', '"2026-06-01T00:00:00.000Z"'],
    ['a number', '42'],
    ['null', 'null'],
  ])('reads %s as no timestamps at all', async (_label, content) => {
    await writeFile(filePath, content);

    expect(await readSyncTimestamps(dataDir, provider)).toEqual({});
    expect(await readTierLastSync(dataDir, provider, 'daily')).toBeNull();
  });

  it('is replaced by a well-formed map on the next recorded sync', async () => {
    await writeFile(filePath, '["daily", "2026-06-01T00:00:00.000Z"]');

    await writeTierLastSync(dataDir, provider, 'daily', '2026-06-26T10:00:00.000Z');

    const written: unknown = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(written).toEqual({ daily: '2026-06-26T10:00:00.000Z' });
    expect(await readTierLastSync(dataDir, provider, 'daily')).toBe('2026-06-26T10:00:00.000Z');
  });
});
