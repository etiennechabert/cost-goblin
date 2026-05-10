import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDuckDBClient } from '../main/duckdb-client.js';
import type { DuckDBClient } from '../main/duckdb-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', '..', 'out', 'worker', 'duckdb-worker.cjs');

// Fail loudly instead of silently skipping tests when the bundle is missing
if (!existsSync(workerPath)) {
  throw new Error(
    `Worker bundle not found at ${workerPath}. Run "npm run build:worker" in packages/desktop first.`,
  );
}

describe('DuckDBClient streaming', () => {
  let client: DuckDBClient;

  beforeAll(async () => {
    client = await createDuckDBClient(workerPath);
  });

  afterAll(async () => {
    await client.terminate();
  });

  it('should stream query results in chunks', async () => {
    const chunks: Array<{ rows: unknown[]; hasMore: boolean }> = [];
    let startedCalled = false;

    await client.queryStreaming(
      'SELECT * FROM range(0, 5000)',
      (rows, hasMore) => {
        chunks.push({ rows, hasMore });
      },
      () => {
        startedCalled = true;
      },
    );

    expect(startedCalled).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);

    // Verify the last chunk has hasMore=false
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk?.hasMore).toBe(false);

    // Verify all chunks except the last have hasMore=true
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]?.hasMore).toBe(true);
    }

    // Count total rows
    const totalRows = chunks.reduce((sum, chunk) => sum + chunk.rows.length, 0);
    expect(totalRows).toBe(5000);
  });

  it('should handle errors in streaming queries', async () => {
    await expect(
      client.queryStreaming(
        'SELECT * FROM nonexistent_table',
        () => {
          // Should not be called
        },
      ),
    ).rejects.toThrow();
  });

  it('should support onStarted callback', async () => {
    let startedCalled = false;
    let chunksCalled = false;

    await client.queryStreaming(
      'SELECT * FROM range(0, 100)',
      () => {
        chunksCalled = true;
        expect(startedCalled).toBe(true);
      },
      () => {
        startedCalled = true;
      },
    );

    expect(startedCalled).toBe(true);
    expect(chunksCalled).toBe(true);
  });
});
