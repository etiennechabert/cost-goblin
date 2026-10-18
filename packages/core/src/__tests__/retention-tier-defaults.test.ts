import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_DAYS, configuredTierRetentions } from '../sync/retention.js';

describe('configuredTierRetentions defaults', () => {
  it('gives a configured hourly tier the hourly default when it sets no window', () => {
    // Hourly is ~24x the bytes of daily; inheriting the daily year would keep
    // twelve times the default the setup wizard writes.
    expect(configuredTierRetentions({ daily: {}, hourly: {} })).toEqual([
      { tier: 'daily', retentionDays: DEFAULT_RETENTION_DAYS.daily },
      { tier: 'hourly', retentionDays: DEFAULT_RETENTION_DAYS.hourly },
    ]);
    expect(DEFAULT_RETENTION_DAYS.hourly).toBe(30);
  });

  it('treats an explicitly undefined window as unset, tier by tier', () => {
    expect(configuredTierRetentions({
      daily: { retentionDays: undefined },
      hourly: { retentionDays: undefined },
      costOptimization: { retentionDays: 45 },
    })).toEqual([
      { tier: 'daily', retentionDays: 365 },
      { tier: 'hourly', retentionDays: 30 },
      { tier: 'cost-optimization', retentionDays: 45 },
    ]);
  });
});
