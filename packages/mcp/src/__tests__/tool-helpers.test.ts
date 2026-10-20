import { describe, it, expect } from 'vitest';
import { SecurityError } from '@costgoblin/core';
import type { CostScopeConfig } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { defaultDateRange, resolveToolDateRange, toDateRange } from '../tools/tool-helpers.js';

describe('toDateRange', () => {
  it('accepts a valid YYYY-MM-DD range', () => {
    expect(toDateRange({ start: '2026-01-01', end: '2026-01-31' })).toEqual({
      start: '2026-01-01',
      end: '2026-01-31',
    });
  });

  it.each([
    ['a quote-breaking end', { start: '2026-01-01', end: "2026-01-31' OR '1'='1" }],
    ['a V8-parseable end', { start: '2026-01-01', end: "31 Jan 2026 (' OR 1=1 OR '" }],
    ['a trailing newline', { start: '2026-01-01', end: '2026-01-31\n' }],
    ['a hostile start', { start: "2026-01-01' --", end: '2026-01-31' }],
  ])('throws SecurityError for %s', (_label, range) => {
    expect(() => toDateRange(range)).toThrow(SecurityError);
  });
});

describe('defaultDateRange', () => {
  // The e2e FIXTURE_NOW; the window must follow the injected clock, not Date.
  const NOW_MS = Date.UTC(2026, 2, 2, 12);

  it('is the 30 days ending at the default lag before now', () => {
    expect(defaultDateRange(NOW_MS)).toEqual({ start: '2026-01-30', end: '2026-02-28' });
  });

  it('honours an explicit lag', () => {
    expect(defaultDateRange(NOW_MS, 0)).toEqual({ start: '2026-02-01', end: '2026-03-02' });
  });
});

describe('resolveToolDateRange', () => {
  // A 7-day lag at 2026-03-02 leaves Feb 23 as the newest day.
  const NOW_MS = Date.UTC(2026, 2, 2, 12);
  const unused = (): never => { throw new Error('not used'); };
  function ctxWithLag(lagDays: number | undefined): McpContext {
    const scope: CostScopeConfig = { costMetric: 'billed', rules: [], ...(lagDays === undefined ? {} : { lagDays }) };
    return {
      dataDir: '/data', stateDir: '/state',
      runQuery: unused, runPreparedQuery: unused, getConfig: unused, getDimensions: unused, getQueryDimensions: unused,
      getCostScope: () => Promise.resolve(scope),
      getAccountMap: unused, getAccountReverseMap: unused, getOrgAccountsPath: unused,
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => NOW_MS,
    };
  }

  it('defaults to the window ending at the configured lag', async () => {
    expect(await resolveToolDateRange(ctxWithLag(7), undefined)).toEqual({ kind: 'range', dateRange: { start: '2026-01-25', end: '2026-02-23' }, cappedAt: null });
    expect(await resolveToolDateRange(ctxWithLag(undefined), undefined, 60)).toEqual({ kind: 'range', dateRange: defaultDateRange(NOW_MS, undefined, 60), cappedAt: null });
  });

  it('keeps a requested range that ends before the cutoff', async () => {
    expect(await resolveToolDateRange(ctxWithLag(7), { start: '2026-02-01', end: '2026-02-23' }))
      .toEqual({ kind: 'range', dateRange: { start: '2026-02-01', end: '2026-02-23' }, cappedAt: null });
  });

  it('cuts a requested range back to the cutoff, naming it', async () => {
    expect(await resolveToolDateRange(ctxWithLag(7), { start: '2026-02-01', end: '2026-02-28' }))
      .toEqual({ kind: 'range', dateRange: { start: '2026-02-01', end: '2026-02-23' }, cappedAt: '2026-02-23' });
  });

  it('reports a range entirely within the lag', async () => {
    expect(await resolveToolDateRange(ctxWithLag(7), { start: '2026-02-24', end: '2026-02-28' }))
      .toEqual({ kind: 'within-lag', requested: { start: '2026-02-24', end: '2026-02-28' }, cutoff: '2026-02-23' });
  });

  it('still refuses a malformed range', async () => {
    await expect(resolveToolDateRange(ctxWithLag(7), { start: '2026-02-01', end: "2026-02-28' OR '1'='1" })).rejects.toThrow(SecurityError);
  });
});
