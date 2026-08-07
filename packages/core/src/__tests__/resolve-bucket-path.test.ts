import { describe, it, expect } from 'vitest';
import { resolveBucketPath } from '../sync/sync-utils.js';
import { validateConfig } from '../config/validator.js';
import type { ProviderConfig } from '../types/config.js';

/** Providers are built through the real validator rather than hand-rolled:
 *  `ProviderName` and `BucketPath` are branded, and validation is how the rest
 *  of the suite obtains them without a type assertion. */
function provider(entry: Record<string, unknown>): ProviderConfig {
  const config = validateConfig({
    providers: [entry],
    defaults: { periodDays: 30, costMetric: 'effective', lagDays: 1 },
  });
  const first = config.providers[0];
  if (first === undefined) throw new Error('validateConfig returned no providers');
  return first;
}

const gcp = (hourly?: string): ProviderConfig => provider({
  name: 'gcp-main',
  type: 'gcp',
  sync: {
    daily: { bucket: 'gs://b/focus/daily', retentionDays: 365 },
    ...(hourly === undefined ? {} : { hourly: { bucket: hourly, retentionDays: 14 } }),
    intervalMinutes: 60,
  },
});

const aws = (extra: Record<string, unknown> = {}): ProviderConfig => provider({
  name: 'aws-main',
  type: 'aws',
  credentialsProfile: 'default',
  sync: {
    daily: { bucket: 's3://b/daily', retentionDays: 365 },
    ...extra,
    intervalMinutes: 60,
  },
});

describe('resolveBucketPath — gcp arm', () => {
  it('resolves each configured tier to its own folder', () => {
    const p = gcp('gs://b/focus/hourly');
    expect(resolveBucketPath(p, 'daily')).toBe('gs://b/focus/daily');
    expect(resolveBucketPath(p, 'hourly')).toBe('gs://b/focus/hourly');
  });

  it('refuses an hourly request rather than falling back to daily', () => {
    // The AWS arm falls back (`hourly ?? daily`). Doing the same here would
    // sync rolled-up daily rows into `raw/hourly-*`, and the intraday views
    // would render one flat 24-hour block per day — a data bug to look at,
    // rather than the missing configuration it actually is.
    expect(() => resolveBucketPath(gcp(), 'hourly')).toThrow(/no sync\.hourly bucket/);
  });

  it('refuses cost-optimization, which has no GCP analogue', () => {
    expect(() => resolveBucketPath(gcp('gs://b/focus/hourly'), 'cost-optimization'))
      .toThrow(/Cost Optimization Hub/);
  });

  it('names the provider so a multi-provider workspace says which one', () => {
    expect(() => resolveBucketPath(gcp(), 'hourly')).toThrow(/"gcp-main"/);
  });
});

describe('resolveBucketPath — aws arm keeps its fallback', () => {
  it('uses the hourly bucket when configured', () => {
    expect(resolveBucketPath(aws({ hourly: { bucket: 's3://b/hourly', retentionDays: 14 } }), 'hourly'))
      .toBe('s3://b/hourly');
  });

  it('falls back to daily when it is not', () => {
    // Long-standing AWS behaviour, asserted here so the gcp arm above reads as
    // a deliberate divergence rather than an oversight.
    expect(resolveBucketPath(aws(), 'hourly')).toBe('s3://b/daily');
  });

  it('resolves and requires the cost-optimization tier', () => {
    expect(resolveBucketPath(aws({ costOptimization: { bucket: 's3://b/co', retentionDays: 30 } }), 'cost-optimization'))
      .toBe('s3://b/co');
    expect(() => resolveBucketPath(aws(), 'cost-optimization')).toThrow(/Cost optimization not configured/);
  });
});
