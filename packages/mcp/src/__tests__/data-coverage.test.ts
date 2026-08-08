import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProviderName, asBucketPath } from '@costgoblin/core';
import type { CostGoblinConfig } from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { computeDataCoverage } from '../tools/tool-helpers.js';

/** The MCP query tools union EVERY configured provider's data; the coverage
 *  banner must describe that same union. Computing it off the first provider
 *  alone reported "no synced data" (or stale months) while a later provider's
 *  rows came back in the query — the bug this suite pins. */

let dataDir: string;

async function writeMonth(provider: string, month: string): Promise<void> {
  const dir = join(dataDir, provider, 'raw', `daily-${month}`);
  await mkdir(dir, { recursive: true });
  // listLocalMonths only requires a .parquet file to exist, not to be valid —
  // latestDay comes from the stubbed runQuery below, so no real Parquet needed.
  await writeFile(join(dir, 'data.parquet'), '');
}

const AWS_PROVIDER = {
  name: asProviderName('aws'), type: 'aws' as const, credentialsProfile: 'default',
  sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 90 }, intervalMinutes: 60 },
};
const GCP_PROVIDER = {
  name: asProviderName('gcp'), type: 'gcp' as const,
  sync: { daily: { bucket: asBucketPath('gs://b/d'), retentionDays: 90 }, costOptimization: undefined, intervalMinutes: 60 },
};

const TWO_PROVIDERS: CostGoblinConfig = {
  // aws is provider[0] but has only the OLDEST month — the pre-fix code would
  // report coverage from this provider alone.
  providers: [AWS_PROVIDER, GCP_PROVIDER],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

function ctxWith(config: CostGoblinConfig, latestDay: string | null): McpContext {
  const stub = (): never => { throw new Error('not used by computeDataCoverage'); };
  return {
    dataDir,
    stateDir: dataDir,
    runQuery: (): Promise<RawRow[]> => Promise.resolve(latestDay === null ? [] : [{ d: latestDay }]),
    runPreparedQuery: stub,
    getConfig: () => Promise.resolve(config),
    getDimensions: stub,
    getQueryDimensions: stub,
    getCostScope: stub,
    getAccountMap: stub,
    getAccountReverseMap: stub,
    getOrgAccountsPath: stub,
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
  };
}

describe('computeDataCoverage — multi-provider', () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cg-mcp-coverage-'));
    await writeMonth('aws', '2026-05');
    await writeMonth('gcp', '2026-06');
    await writeMonth('gcp', '2026-07');
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reports the union of every provider\'s months, not just the first', async () => {
    const coverage = await computeDataCoverage(ctxWith(TWO_PROVIDERS, '2026-07-15'));
    expect(coverage.availableMonths).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(coverage.earliestDay).toBe('2026-05-01');
    expect(coverage.latestDay).toBe('2026-07-15');
  });

  it('does not falsely report empty coverage when a later provider has data', async () => {
    // A config whose FIRST provider has nothing on disk — the pre-fix code
    // keyed coverage off provider[0] and would report empty.
    const firstProviderEmpty: CostGoblinConfig = {
      ...TWO_PROVIDERS,
      providers: [
        {
          name: asProviderName('aws-empty'), type: 'aws' as const, credentialsProfile: 'default',
          sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 90 }, intervalMinutes: 60 },
        },
        GCP_PROVIDER,
      ],
    };
    const coverage = await computeDataCoverage(ctxWith(firstProviderEmpty, '2026-07-15'));
    expect(coverage.availableMonths.length).toBeGreaterThan(0);
    expect(coverage.availableMonths).toContain('2026-07');
  });

  it('flags the missing interior month across the union', async () => {
    // aws 2026-05, gcp 2026-06 + 2026-07 → no gap; add an isolated later month
    // to force one.
    await writeMonth('gcp', '2026-09');
    const coverage = await computeDataCoverage(ctxWith(TWO_PROVIDERS, '2026-09-10'));
    expect(coverage.availableMonths).toContain('2026-09');
    expect(coverage.missingPeriods).toContain('2026-08');
  });
});
