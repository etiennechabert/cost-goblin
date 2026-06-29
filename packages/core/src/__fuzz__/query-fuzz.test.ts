import { describe, expect, it } from 'vitest';

import { describeCase, runBatch } from './batch.js';

/**
 * Seeded query fuzzer (Layer 2: real DuckDB against synthetic fixtures).
 *
 * Throws a deterministic batch of adversarial-but-type-valid query params at the
 * real builders + a real prepared-statement execution, then asserts the safety
 * invariant the security model depends on: no hostile input can hang the query
 * or escape parameterization into the SQL structure.
 *
 * A failure prints the exact case JSON — re-run a single seed with:
 *   npx tsx packages/core/src/__fuzz__/run.ts --seed <seed> --count <n>
 */
const SEED = 0xc057;
const COUNT = 250;

describe('query fuzzer', () => {
  it('survives a seeded adversarial batch without hangs or injections', async () => {
    const summary = await runBatch({ seed: SEED, count: COUNT });

    const bugReport = summary.bugs
      .map(o => `  [${o.result.kind}] injection=${String(o.injection)} :: ${describeCase(o.case)}`)
      .join('\n');
    expect(summary.bugs, `fuzz bugs found (seed ${String(SEED)}):\n${bugReport}`).toHaveLength(0);

    // Sanity: the batch actually drove real query execution against real data,
    // rather than every case bouncing off the validation layer.
    expect(summary.buckets.executed).toBeGreaterThanOrEqual(Math.floor(COUNT * 0.2));
    expect(summary.executedWithRows).toBeGreaterThan(0);

    // The identifier allow-list is exercised: hostile dimension ids are rejected.
    expect(summary.buckets['rejected-security']).toBeGreaterThan(0);
  }, 120_000);
});
