import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getRawDirPrefix, logger } from '@costgoblin/core';
import type { TagDimension } from '@costgoblin/core';
import { isSortFresh, isSidecarFresh } from './optimize.js';
import type { OptimizeQueue } from './optimize-queue.js';

/**
 * Scan raw Parquet files on disk and enqueue any that aren't fully optimized
 * (missing a sort marker, or missing a sidecar for any configured tag dim).
 *
 * Run once at app startup. optimizeFile is idempotent, so it's safe to
 * enqueue everything — already-fresh files short-circuit inside.
 *
 * Fires and forgets — the queue drains in the background while the user
 * interacts with the app. Query handlers fall back to element_at mode until
 * files are optimized, so no query is blocked on this.
 */
export async function enqueueStartupMigration(
  dataDir: string,
  tags: readonly TagDimension[],
  queue: OptimizeQueue,
): Promise<number> {
  let enqueued = 0;
  for (const tier of ['daily', 'hourly'] as const) {
    const prefix = getRawDirPrefix(tier);
    const rawRoot = join(dataDir, 'aws', 'raw');
    let periodDirs: string[] = [];
    try {
      const entries = await readdir(rawRoot);
      periodDirs = entries.filter(e => e.startsWith(`${prefix}-`));
    } catch {
      continue;
    }
    for (const periodDir of periodDirs) {
      const dir = join(rawRoot, periodDir);
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter(f => f.endsWith('.parquet'));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(dir, f);
        if (await needsOptimize(path, tags)) {
          queue.enqueue(path);
          enqueued += 1;
        }
      }
    }
  }
  if (enqueued > 0) {
    logger.info(`startup migration: enqueued ${String(enqueued)} files for optimize`);
  }
  return enqueued;
}

async function needsOptimize(rawPath: string, tags: readonly TagDimension[]): Promise<boolean> {
  if (!(await isSortFresh(rawPath))) return true;
  if (tags.length > 0 && !(await isSidecarFresh(rawPath))) return true;
  return false;
}
