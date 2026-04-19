import type { TagDimension } from '@costgoblin/core';
import { logger } from '@costgoblin/core';
import type { DuckDBClient } from './duckdb-client.js';
import type { FileActivityLog } from './file-activity.js';
import { optimizeFile } from './optimize.js';

/**
 * Per-file optimize queue (sort + sidecar generation). Each COPY ORDER BY
 * already fans out across cores inside DuckDB, so running too many files
 * in parallel just oversubscribes CPU and starves query traffic. We run a
 * small, fixed number of workers (default 2) — enough to overlap parquet
 * I/O between files, few enough to leave connections free in the 4-slot
 * pool for user queries.
 */
const MAX_PARALLEL = 2;

export interface OptimizeQueueDeps {
  readonly client: DuckDBClient;
  readonly activity: FileActivityLog;
  readonly getTags: () => Promise<readonly TagDimension[]>;
  readonly getOrgAccountsPath: () => Promise<string | undefined>;
  /** Gate read on every worker pickup; flipping false drains cleanly. */
  readonly isEnabled: () => Promise<boolean>;
}

export interface OptimizeQueue {
  enqueue(rawPath: string): void;
  /** Call when the enabled flag flips to true — spawns workers if needed. */
  kick(): void;
  /** Drop queued entries whose path matches the predicate. */
  removeWhere(predicate: (rawPath: string) => boolean): void;
  size(): number;
  running(): boolean;
}

export function createOptimizeQueue(deps: OptimizeQueueDeps): OptimizeQueue {
  const pending: string[] = [];
  const pendingSet = new Set<string>();
  let activeWorkers = 0;

  async function runOne(path: string): Promise<void> {
    try {
      const tags = await deps.getTags();
      const orgAccountsPath = await deps.getOrgAccountsPath();
      await optimizeFile({
        rawPath: path,
        tags,
        orgAccountsPath,
        client: deps.client,
        activity: deps.activity,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`optimize failed for ${path}: ${message}`);
    }
  }

  async function worker(): Promise<void> {
    while (pending.length > 0) {
      // Re-check gate each pickup. In-flight file completes; next file waits.
      if (!(await deps.isEnabled())) return;
      const path = pending.shift();
      if (path === undefined) return;
      pendingSet.delete(path);
      await runOne(path);
    }
  }

  function spawnWorkers(): void {
    while (activeWorkers < MAX_PARALLEL && pending.length > 0) {
      activeWorkers++;
      void worker().finally(() => { activeWorkers--; });
    }
  }

  return {
    enqueue(rawPath: string): void {
      if (pendingSet.has(rawPath)) return;
      pendingSet.add(rawPath);
      pending.push(rawPath);
      // Fire-and-forget gate probe — if disabled, no workers spin up.
      void deps.isEnabled().then(on => { if (on) spawnWorkers(); });
    },
    kick(): void {
      void deps.isEnabled().then(on => { if (on) spawnWorkers(); });
    },
    removeWhere(predicate: (rawPath: string) => boolean): void {
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (p !== undefined && predicate(p)) {
          pending.splice(i, 1);
          pendingSet.delete(p);
        }
      }
    },
    size(): number {
      return pending.length;
    },
    running(): boolean {
      return activeWorkers > 0;
    },
  };
}
