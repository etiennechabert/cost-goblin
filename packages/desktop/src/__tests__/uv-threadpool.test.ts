import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeQueryPoolSize, maxRollupConcurrency } from '../main/duckdb-tuning.js';
import { ensureUvThreadpoolSize, uvThreadpoolSize } from '../main/uv-threadpool.js';

describe('uvThreadpoolSize', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('leaves threads free beyond every DuckDB call the app allows at once', () => {
    // The shared instance's pooled queries and builds, and the sandboxed instance's queries.
    const duckdbCalls = computeQueryPoolSize() + maxRollupConcurrency() + computeQueryPoolSize();
    expect(uvThreadpoolSize()).toBeGreaterThanOrEqual(duckdbCalls + 4);
    // libuv's default, which the app's own limits exceed.
    expect(uvThreadpoolSize()).toBeGreaterThan(4);
    // libuv refuses more than this.
    expect(uvThreadpoolSize()).toBeLessThanOrEqual(1024);
  });

  it('follows the pool-size override', () => {
    vi.stubEnv('COSTGOBLIN_DUCKDB_POOL_SIZE', '1');
    const small = uvThreadpoolSize();
    vi.stubEnv('COSTGOBLIN_DUCKDB_POOL_SIZE', '32');
    expect(uvThreadpoolSize()).toBe(small + 3 * 31);
  });
});

describe('ensureUvThreadpoolSize', () => {
  it('sizes the pool when the environment does not', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureUvThreadpoolSize(env);
    expect(env['UV_THREADPOOL_SIZE']).toBe(String(uvThreadpoolSize()));

    const blank: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: ' ' };
    ensureUvThreadpoolSize(blank);
    expect(blank['UV_THREADPOOL_SIZE']).toBe(String(uvThreadpoolSize()));
  });

  it('keeps a size the environment already names', () => {
    const env: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '6' };
    ensureUvThreadpoolSize(env);
    expect(env['UV_THREADPOOL_SIZE']).toBe('6');
  });
});
