import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asBucketPath, asDateString, asDimensionId, asProviderName } from '@costgoblin/core';
import type { CostGoblinConfig, CostScopeConfig, DimensionsConfig } from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import {
  buildQueryContextOpts,
  computeDataCoverage,
  lookupDimension,
  toFilterMap,
  toNum,
  toStr,
} from '../tools/tool-helpers.js';

// computeDataCoverage and buildQueryContextOpts when the config, the Cost
// Scope or the latest-day probe can't be read, and the month arithmetic of
// the coverage banner across a year boundary.

const CONFIG: CostGoblinConfig = {
  providers: [{
    name: asProviderName('aws'), type: 'aws', credentialsProfile: 'default',
    sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 90 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};
const DIMENSIONS: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [{ tagName: 'team', label: 'Team' }],
};
const COST_SCOPE: CostScopeConfig = { costMetric: 'billed', rules: [] };
const NOW = Date.UTC(2026, 1, 25, 12);
const JAN = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };

let root: string;

/** A data dir holding the given daily months for provider `aws`. */
async function dataDirWith(name: string, months: readonly string[]): Promise<string> {
  const dir = join(root, name);
  for (const month of months) {
    const monthDir = join(dir, 'aws', 'raw', `daily-${month}`);
    await mkdir(monthDir, { recursive: true });
    await writeFile(join(monthDir, 'data.parquet'), '');
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

function ctxWith(dataDir: string, overrides: Partial<McpContext> = {}): McpContext {
  const unused = (): never => { throw new Error('not used here'); };
  return {
    dataDir,
    stateDir: dataDir,
    runQuery: (): Promise<RawRow[]> => Promise.resolve([{ d: '2026-02-20' }]),
    runPreparedQuery: unused,
    getConfig: () => Promise.resolve(CONFIG),
    getDimensions: () => Promise.resolve(DIMENSIONS),
    getQueryDimensions: () => Promise.resolve(DIMENSIONS),
    getCostScope: () => Promise.resolve(COST_SCOPE),
    getAccountMap: () => Promise.resolve(new Map<string, string>()),
    getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>([['Prod', ['111']]])),
    getOrgAccountsPath: () => Promise.resolve('/state/org-accounts.json'),
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
    now: () => NOW,
    ...overrides,
  };
}

let janFeb: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cg-mcp-coverage-edges-'));
  janFeb = await dataDirWith('jan-feb', ['2026-01', '2026-02']);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('computeDataCoverage', () => {
  it('reports nothing synced when the config cannot be read', async () => {
    const ctx = ctxWith(janFeb, { getConfig: () => Promise.reject(new Error('costgoblin.yaml missing')) });
    const empty = {
      availableMonths: [], latestDay: null, lagDays: null, earliestDay: null, missingPeriods: [], totalDays: null,
    };
    // With a requested range every month of it is missing; without one, none is.
    expect(await computeDataCoverage(ctx, { start: '2026-01-15', end: '2026-02-10' }))
      .toEqual({ ...empty, missingInRange: ['2026-01', '2026-02'] });
    expect(await computeDataCoverage(ctx)).toEqual({ ...empty, missingInRange: [] });
  });

  it('measures the span and the lag from the latest day the probe finds', async () => {
    expect(await computeDataCoverage(ctxWith(janFeb), { start: '2026-02-01', end: '2026-03-31' })).toEqual({
      availableMonths: ['2026-01', '2026-02'],
      latestDay: '2026-02-20',
      lagDays: 5,
      earliestDay: '2026-01-01',
      missingPeriods: [],
      missingInRange: ['2026-03'],
      totalDays: 51,
    });
  });

  it.each([
    ['returns no row', (): Promise<RawRow[]> => Promise.resolve([])],
    ['returns a non-date value', (): Promise<RawRow[]> => Promise.resolve([{ d: 20260220 }])],
    ['returns a too-short string', (): Promise<RawRow[]> => Promise.resolve([{ d: '2026-02' }])],
    ['fails', (): Promise<RawRow[]> => Promise.reject(new Error('IO Error: no such file'))],
  ])('leaves the latest day, lag and span unknown when the probe %s', async (_label, runQuery) => {
    const coverage = await computeDataCoverage(ctxWith(janFeb, { runQuery }));
    expect(coverage).toMatchObject({
      availableMonths: ['2026-01', '2026-02'],
      earliestDay: '2026-01-01',
      latestDay: null,
      lagDays: null,
      totalDays: null,
    });
  });

  it('never reports a negative lag for data dated after the clock', async () => {
    const ctx = ctxWith(janFeb, { now: () => Date.UTC(2026, 1, 10) });
    expect((await computeDataCoverage(ctx)).lagDays).toBe(0);
  });

  it('lists the months missing between the earliest and latest across a year boundary', async () => {
    const gappy = await dataDirWith('gappy', ['2025-11', '2026-02']);
    const coverage = await computeDataCoverage(ctxWith(gappy));
    expect(coverage.availableMonths).toEqual(['2025-11', '2026-02']);
    expect(coverage.missingPeriods).toEqual(['2025-12', '2026-01']);
  });
});

describe('buildQueryContextOpts', () => {
  it('builds the query options from the context', async () => {
    const sources: string[] = [];
    const ctx = ctxWith(janFeb, {
      materializedBase: {
        getSource: (range, tier) => {
          sources.push(`${range.start}..${range.end}@${tier}`);
          return 'cost_base';
        },
      },
    });
    const { opts, empty } = await buildQueryContextOpts(ctx, JAN);
    expect(empty).toBe(false);
    expect(opts.costScope).toBe(COST_SCOPE);
    expect(opts.materializedSource).toBe('cost_base');
    expect(opts.orgAccountsPath).toBe('/state/org-accounts.json');
    expect(opts.providers).toEqual([{ name: 'aws', availablePeriods: ['2026-01', '2026-02'] }]);
    expect(opts.accountReverseMap?.get('Prod')).toEqual(['111']);
    expect(sources).toEqual(['2026-01-01..2026-01-31@daily']);
  });

  // An answer without the user's metric and exclusion rules would read as
  // the real cost.
  it('fails when the Cost Scope does not load, rather than answering unscoped', async () => {
    const ctx = ctxWith(janFeb, { getCostScope: () => Promise.reject(new Error("Couldn't load cost-scope.yaml: rules must be an array")) });
    await expect(buildQueryContextOpts(ctx, JAN)).rejects.toThrow("Couldn't load cost-scope.yaml");
  });

  it('reads the hourly tier when asked and is empty when that tier has no month in range', async () => {
    const { opts, empty } = await buildQueryContextOpts(ctxWith(janFeb), JAN, 'hourly');
    expect(empty).toBe(true);
    expect(opts.providers).toEqual([{ name: 'aws', availablePeriods: [] }]);
    expect(opts.costScope).toEqual(COST_SCOPE);
    expect(opts.materializedSource).toBeUndefined();
  });
});

describe('small tool helpers', () => {
  it('toNum reads numbers and bigints, anything else as 0', () => {
    expect([toNum(2.5), toNum(7n), toNum('3'), toNum(null)]).toEqual([2.5, 7, 0, 0]);
  });

  it('toStr reads strings, numbers, booleans and dates, anything else as empty', () => {
    expect([
      toStr('a'), toStr(null), toStr(undefined), toStr(4), toStr(false),
      toStr(new Date('2026-03-04T23:00:00Z')), toStr({ a: 1 }), toStr(5n),
    ]).toEqual(['a', '', '', '4', 'false', '2026-03-04', '', '']);
  });

  it('toFilterMap brands every value and treats a missing map as no filters', () => {
    expect(toFilterMap(undefined)).toEqual({});
    expect(toFilterMap({ service: ['EC2', 'S3'], tag_team: [] })).toEqual({ service: ['EC2', 'S3'], tag_team: [] });
  });

  it('lookupDimension finds built-ins by name and tags by id, and reports unknown ids', () => {
    expect(lookupDimension('service', DIMENSIONS)).toEqual({ label: 'Service', found: true });
    expect(lookupDimension('tag_team', DIMENSIONS)).toEqual({ label: 'Team', found: true });
    expect(lookupDimension('colour', DIMENSIONS)).toEqual({ label: 'colour', found: false });
  });
});
