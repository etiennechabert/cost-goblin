/**
 * Runs a seeded batch of generated cases through the harness and tallies the
 * outcomes. Shared by the deterministic regression test (fixed seed) and the
 * standalone soak runner (large / random seed).
 */
import { generateCase } from './generate.js';
import type { FuzzCase } from './generate.js';
import { FuzzHarness } from './harness.js';
import type { FuzzOutcome, FuzzResult } from './harness.js';
import { makeRng } from './prng.js';

export interface FuzzSummary {
  readonly seed: number;
  readonly total: number;
  readonly buckets: Record<FuzzResult['kind'], number>;
  /** Cases that executed and returned at least one row. */
  readonly executedWithRows: number;
  /** Cases generated from all-valid identifiers/dates. */
  readonly intendedValidTotal: number;
  /** ...of those, how many actually executed without error. */
  readonly intendedValidExecuted: number;
  /** Hangs and successful injections — these are bugs. */
  readonly bugs: readonly FuzzOutcome[];
  /** Non-security synchronous throws from a builder — noteworthy, not failing. */
  readonly builderRejections: readonly FuzzOutcome[];
}

function emptyBuckets(): Record<FuzzResult['kind'], number> {
  return { executed: 0, 'rejected-security': 0, 'rejected-builder': 0, 'rejected-duckdb': 0, timeout: 0 };
}

function isBug(o: FuzzOutcome): boolean {
  return o.result.kind === 'timeout' || o.injection;
}

/** Compact, replayable description of a single case for failure reporting. */
export function describeCase(c: FuzzCase): string {
  return JSON.stringify({ kind: c.kind, intendedValid: c.intendedValid, params: c.params });
}

export async function runBatch(opts: { readonly seed: number; readonly count: number }): Promise<FuzzSummary> {
  const rng = makeRng(opts.seed);
  const harness = await FuzzHarness.open();
  const buckets = emptyBuckets();
  const bugs: FuzzOutcome[] = [];
  const builderRejections: FuzzOutcome[] = [];
  let executedWithRows = 0;
  let intendedValidTotal = 0;
  let intendedValidExecuted = 0;

  try {
    for (let i = 0; i < opts.count; i++) {
      const c = generateCase(rng);
      const outcome = await harness.run(c);
      buckets[outcome.result.kind] += 1;
      if (c.intendedValid) intendedValidTotal += 1;
      if (outcome.result.kind === 'executed') {
        if (c.intendedValid) intendedValidExecuted += 1;
        if (outcome.result.rowCount > 0) executedWithRows += 1;
      }
      if (outcome.result.kind === 'rejected-builder') builderRejections.push(outcome);
      if (isBug(outcome)) bugs.push(outcome);
    }
  } finally {
    harness.close();
  }

  return {
    seed: opts.seed,
    total: opts.count,
    buckets,
    executedWithRows,
    intendedValidTotal,
    intendedValidExecuted,
    bugs,
    builderRejections,
  };
}
