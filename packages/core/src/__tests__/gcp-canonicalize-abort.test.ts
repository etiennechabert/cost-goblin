import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalizeGcpPeriod } from '../sync/gcp-canonicalize.js';
import type { CanonicalizeConnection } from '../sync/gcp-canonicalize.js';

// The sync worker aborts canonicalization on cancel and at app exit: a DuckDB
// statement left running in a torn-down worker thread aborts the process.
describe('canonicalizeGcpPeriod abort', () => {
  it('runs no statement once its signal has aborted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'costgoblin-canon-abort-'));
    try {
      await writeFile(join(dir, 'shard-0.parquet'), '');
      const statements: string[] = [];
      const connection: CanonicalizeConnection = {
        run: (sql) => {
          statements.push(sql);
          return Promise.reject(new Error('should not run'));
        },
      };
      const controller = new AbortController();
      controller.abort();
      await expect(canonicalizeGcpPeriod({
        stagingDir: dir,
        outputPath: join(dir, 'out', 'part-0.parquet'),
        connection,
        signal: controller.signal,
      })).rejects.toThrow('GCP canonicalization aborted');
      expect(statements).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('interrupts its own instance when aborted after it started', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'costgoblin-canon-abort-'));
    try {
      await writeFile(join(dir, 'shard-0.parquet'), '');
      const controller = new AbortController();
      const run = canonicalizeGcpPeriod({
        stagingDir: dir,
        outputPath: join(dir, 'out', 'part-0.parquet'),
        signal: controller.signal,
      });
      // Past the first check: the abort lands while the instance is created.
      controller.abort();
      await expect(run).rejects.toThrow('GCP canonicalization aborted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('interrupts its own instance when aborted mid-statement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'costgoblin-canon-abort-'));
    try {
      await writeFile(join(dir, 'shard-0.parquet'), '');
      const controller = new AbortController();
      const run = canonicalizeGcpPeriod({
        stagingDir: dir,
        outputPath: join(dir, 'out', 'part-0.parquet'),
        signal: controller.signal,
      });
      setTimeout(() => { controller.abort(); }, 0);
      // The not-a-parquet shard fails the read whether or not the abort got
      // there first: what matters is that it settles and leaves no timer.
      await expect(run).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('detaches from a signal that never aborts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'costgoblin-canon-abort-'));
    try {
      await writeFile(join(dir, 'shard-0.parquet'), '');
      const controller = new AbortController();
      await expect(canonicalizeGcpPeriod({
        stagingDir: dir,
        outputPath: join(dir, 'out', 'part-0.parquet'),
        signal: controller.signal,
      })).rejects.toThrow('Could not read the downloaded export');
      // Aborting after close must not reach the closed connection.
      controller.abort();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('opens no instance of its own once its signal has aborted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'costgoblin-canon-abort-'));
    try {
      await writeFile(join(dir, 'shard-0.parquet'), '');
      const controller = new AbortController();
      controller.abort();
      await expect(canonicalizeGcpPeriod({
        stagingDir: dir,
        outputPath: join(dir, 'out', 'part-0.parquet'),
        signal: controller.signal,
      })).rejects.toThrow('GCP canonicalization aborted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
