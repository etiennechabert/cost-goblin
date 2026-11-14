import { afterEach, describe, it, expect, vi } from 'vitest';
import { totalmem } from 'node:os';
import {
  DEFAULT_ROLLUP_CONCURRENCY,
  MAX_MEMORY_GB,
  MIN_MEMORY_GB,
  clampMemoryGB,
  clampRollupConcurrency,
  clampThreads,
  computeDefaultMemoryGB,
  computeDefaultPoolSize,
  computeDefaultThreads,
  computeQueryPoolSize,
  computeUvThreadPoolSize,
  DUCKDB_SETTINGS_ENV,
  duckdbProcessEnv,
  maxRollupConcurrency,
  maxThreads,
  resolveMemoryGB,
  resolveRollupConcurrency,
  resolveThreads,
  totalMemoryGB,
} from '../main/duckdb-tuning.js';

// Pass-through, so a test can stand in for a machine of another size.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, totalmem: vi.fn(actual.totalmem) };
});

const GIB = 1024 * 1024 * 1024;
/** Memory the other in-process DuckDB instances may take from the same
 *  allocator: the MCP sandbox and the GCP canonicalizer, 2 GB each. */
const OTHER_INSTANCES_GB = 4;
/** Resident size at which the app died when DuckDB's limit let it get there. */
const OBSERVED_CEILING_GB = 9;

afterEach(() => { vi.mocked(totalmem).mockReset(); });

describe('the memory ceiling', () => {
  it('leaves the main process allocator room, with every instance at its limit', () => {
    expect(MAX_MEMORY_GB + OTHER_INSTANCES_GB).toBeLessThan(OBSERVED_CEILING_GB);
  });

  it('is the default however much RAM the machine has', () => {
    for (const gb of [8, 16, 32, 48, 128]) {
      vi.mocked(totalmem).mockReturnValue(gb * GIB);
      expect(computeDefaultMemoryGB()).toBe(MAX_MEMORY_GB);
    }
  });

  it('gives a small machine half its RAM', () => {
    vi.mocked(totalmem).mockReturnValue(4 * GIB);
    expect(computeDefaultMemoryGB()).toBe(2);
    vi.mocked(totalmem).mockReturnValue(1 * GIB);
    expect(computeDefaultMemoryGB()).toBe(MIN_MEMORY_GB);
  });

  it('holds an override to the ceiling: a saved 24 GB cannot bring the crash back', () => {
    vi.mocked(totalmem).mockReturnValue(48 * GIB);
    expect(clampMemoryGB(24)).toBe(MAX_MEMORY_GB);
    expect(resolveMemoryGB(24)).toBe(MAX_MEMORY_GB);
    expect(resolveMemoryGB(2)).toBe(2);
  });
});

describe('duckdb-tuning defaults', () => {
  it('memory default stays within [MIN, MAX] and never exceeds total RAM', () => {
    const def = computeDefaultMemoryGB();
    expect(def).toBeGreaterThanOrEqual(MIN_MEMORY_GB);
    expect(def).toBeLessThanOrEqual(MAX_MEMORY_GB);
    expect(def).toBeLessThanOrEqual(totalMemoryGB());
  });

  it('thread default is at least 1 and at most the logical core count', () => {
    const def = computeDefaultThreads();
    expect(def).toBeGreaterThanOrEqual(1);
    expect(def).toBeLessThanOrEqual(maxThreads());
  });
});

describe('clampMemoryGB', () => {
  it('floors at MIN_MEMORY_GB', () => {
    expect(clampMemoryGB(0)).toBe(MIN_MEMORY_GB);
    expect(clampMemoryGB(-10)).toBe(MIN_MEMORY_GB);
  });
  it('caps at min(MAX_MEMORY_GB, total RAM)', () => {
    const ceiling = Math.min(MAX_MEMORY_GB, totalMemoryGB());
    expect(clampMemoryGB(10_000)).toBe(ceiling);
  });
  it('rounds and passes through in-range values', () => {
    const ceiling = Math.min(MAX_MEMORY_GB, totalMemoryGB());
    if (ceiling >= 3) expect(clampMemoryGB(3)).toBe(3);
    expect(clampMemoryGB(2.4)).toBe(2);
  });
});

describe('clampThreads', () => {
  it('floors at 1 and caps at the logical core count', () => {
    expect(clampThreads(0)).toBe(1);
    expect(clampThreads(-3)).toBe(1);
    expect(clampThreads(10_000)).toBe(maxThreads());
  });
});

describe('clampRollupConcurrency', () => {
  it('floors at 1 and caps at maxRollupConcurrency', () => {
    expect(clampRollupConcurrency(0)).toBe(1);
    expect(clampRollupConcurrency(-5)).toBe(1);
    expect(clampRollupConcurrency(10_000)).toBe(maxRollupConcurrency());
  });
  it('rounds and passes through in-range values', () => {
    expect(clampRollupConcurrency(2.4)).toBe(2);
    if (maxRollupConcurrency() >= 3) expect(clampRollupConcurrency(3)).toBe(3);
  });
});

describe('resolve* (override ?? default)', () => {
  it('uses the computed default when override is null/undefined', () => {
    expect(resolveMemoryGB(null)).toBe(computeDefaultMemoryGB());
    expect(resolveMemoryGB(undefined)).toBe(computeDefaultMemoryGB());
    expect(resolveThreads(null)).toBe(computeDefaultThreads());
    expect(resolveThreads(undefined)).toBe(computeDefaultThreads());
  });
  it('uses the clamped override when provided', () => {
    expect(resolveMemoryGB(10_000)).toBe(clampMemoryGB(10_000));
    expect(resolveThreads(10_000)).toBe(clampThreads(10_000));
  });
  it('rollup concurrency defaults to 2 and clamps overrides', () => {
    expect(DEFAULT_ROLLUP_CONCURRENCY).toBe(2);
    expect(resolveRollupConcurrency(null)).toBe(2);
    expect(resolveRollupConcurrency(undefined)).toBe(2);
    expect(resolveRollupConcurrency(1)).toBe(1);
    expect(resolveRollupConcurrency(10_000)).toBe(maxRollupConcurrency());
  });
});

describe('the DuckDB process environment', () => {
  it('gives the process a thread for every query it may run at a time, and some to spare', () => {
    // A running query holds a libuv pool thread until it returns; with fewer
    // threads than queries, the last ones do not start and file reads wait.
    const queries = computeQueryPoolSize() + computeDefaultPoolSize();
    expect(computeUvThreadPoolSize()).toBeGreaterThan(queries);
    // libuv's default, which four pooled queries alone used up.
    expect(computeUvThreadPoolSize()).toBeGreaterThan(4);
    // And its maximum.
    expect(computeUvThreadPoolSize()).toBeLessThanOrEqual(1024);
  });

  it('carries the host environment, the settings and the pool size', () => {
    const env = duckdbProcessEnv({ PATH: '/usr/bin', COSTGOBLIN_DATA_DIR: '/ws/data', UNSET: undefined }, { tempDir: "/ws/tmp/it's here", memoryGB: 2, threads: 4 });

    expect(env).toMatchObject({ PATH: '/usr/bin', COSTGOBLIN_DATA_DIR: '/ws/data', UV_THREADPOOL_SIZE: String(computeUvThreadPoolSize()) });
    expect(JSON.parse(env[DUCKDB_SETTINGS_ENV] ?? '')).toEqual({ tempDir: "/ws/tmp/it's here", memoryGB: 2, threads: 4 });
    // Only strings: an unset variable is left out, not passed as "undefined".
    expect('UNSET' in env).toBe(false);
    expect(Object.values(env).every(value => typeof value === 'string')).toBe(true);
  });

  it('keeps a larger pool the user asked for, and replaces a smaller or unreadable one', () => {
    const ours = computeUvThreadPoolSize();
    expect(duckdbProcessEnv({ UV_THREADPOOL_SIZE: String(ours + 8) }, {})['UV_THREADPOOL_SIZE']).toBe(String(ours + 8));
    expect(duckdbProcessEnv({ UV_THREADPOOL_SIZE: '2' }, {})['UV_THREADPOOL_SIZE']).toBe(String(ours));
    expect(duckdbProcessEnv({ UV_THREADPOOL_SIZE: 'many' }, {})['UV_THREADPOOL_SIZE']).toBe(String(ours));
  });
});
