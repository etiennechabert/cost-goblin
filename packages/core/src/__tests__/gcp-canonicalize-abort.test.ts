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
