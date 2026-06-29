/**
 * Standalone soak runner for the query fuzzer — the "let it brute-force for a
 * while" mode. Unlike the deterministic test (fixed seed, small batch), this
 * runs a large batch and, by default, a fresh seed each invocation so repeated
 * runs explore new territory. Pass --seed to replay a specific run exactly.
 *
 *   npx tsx packages/core/src/__fuzz__/run.ts                # 2000 cases, random seed
 *   npx tsx packages/core/src/__fuzz__/run.ts --count 20000  # longer soak
 *   npx tsx packages/core/src/__fuzz__/run.ts --seed 49239   # replay a reported seed
 *
 * Exits non-zero when a bug (hang or injection) is found.
 */
import { logger } from '../logger/index.js';

import { describeCase, runBatch } from './batch.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  // The shared logger has no default handler outside the app — wire one to
  // stdout so this standalone runner actually prints its report.
  logger.addHandler(entry => {
    const ctx = entry.context === undefined ? '' : ` ${JSON.stringify(entry.context)}`;
    process.stdout.write(`[${entry.level}] ${entry.message}${ctx}\n`);
  });

  const seed = parsePositiveInt(argValue('--seed'), Date.now() & 0xffffffff);
  const count = parsePositiveInt(argValue('--count'), 2000);

  logger.info('query-fuzz: starting', { seed, count });
  const summary = await runBatch({ seed, count });

  logger.info('query-fuzz: outcome buckets', { ...summary.buckets });
  logger.info('query-fuzz: productivity', {
    executedWithRows: summary.executedWithRows,
    intendedValidExecuted: summary.intendedValidExecuted,
    intendedValidTotal: summary.intendedValidTotal,
  });

  if (summary.builderRejections.length > 0) {
    logger.warn('query-fuzz: builders threw non-security errors', {
      count: summary.builderRejections.length,
      samples: summary.builderRejections.slice(0, 5).map(o => describeCase(o.case)),
    });
  }

  if (summary.bugs.length > 0) {
    for (const bug of summary.bugs) {
      logger.error('query-fuzz: BUG', {
        kind: bug.result.kind,
        injection: bug.injection,
        case: describeCase(bug.case),
      });
    }
    logger.error('query-fuzz: FAIL', { seed, bugs: summary.bugs.length });
    process.exitCode = 1;
    return;
  }

  logger.info('query-fuzz: PASS — no hangs or injections', { seed, count });
}

void main();
