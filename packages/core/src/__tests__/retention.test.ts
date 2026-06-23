import { describe, it, expect } from 'vitest';
import {
  retentionCutoffPeriod,
  periodsOutsideRetention,
  configuredTierRetentions,
} from '../sync/retention.js';

// Fixed "now" so the month math is deterministic: 2026-06-23.
const NOW = Date.UTC(2026, 5, 23);

describe('retentionCutoffPeriod', () => {
  it('365 days back lands in the prior year', () => {
    expect(retentionCutoffPeriod(365, NOW)).toBe('2025-06');
  });

  it('30 days back stays within the boundary month', () => {
    // 2026-06-23 minus 30 days = 2026-05-24 → cutoff month 2026-05.
    expect(retentionCutoffPeriod(30, NOW)).toBe('2026-05');
  });

  it('pads single-digit months', () => {
    // 2026-06-23 minus ~150 days lands in January.
    expect(retentionCutoffPeriod(150, NOW)).toBe('2026-01');
  });
});

describe('periodsOutsideRetention', () => {
  const local = ['2025-01', '2025-06', '2026-04', '2026-05', '2026-06'];

  it('returns periods strictly older than the cutoff month, oldest first', () => {
    // 365d cutoff is 2025-06 → only 2025-01 is strictly older.
    expect(periodsOutsideRetention(local, 365, NOW)).toEqual(['2025-01']);
  });

  it('keeps the boundary month (symmetric with the download cutoff)', () => {
    // 30d cutoff is 2026-05; 2026-05 is kept, everything before it pruned.
    expect(periodsOutsideRetention(local, 30, NOW)).toEqual(['2025-01', '2025-06', '2026-04']);
  });

  it('returns nothing when all local data is within retention', () => {
    expect(periodsOutsideRetention(['2026-05', '2026-06'], 365, NOW)).toEqual([]);
  });

  it('guards against retentionDays = 0 — never reports everything as expired', () => {
    expect(periodsOutsideRetention(local, 0, NOW)).toEqual([]);
  });

  it('guards against negative and non-finite retention', () => {
    expect(periodsOutsideRetention(local, -5, NOW)).toEqual([]);
    expect(periodsOutsideRetention(local, Number.NaN, NOW)).toEqual([]);
    expect(periodsOutsideRetention(local, Number.POSITIVE_INFINITY, NOW)).toEqual([]);
  });

  it('handles an empty local set', () => {
    expect(periodsOutsideRetention([], 30, NOW)).toEqual([]);
  });
});

describe('configuredTierRetentions', () => {
  it('always includes daily, with its default when unset', () => {
    expect(configuredTierRetentions({ daily: {} })).toEqual([
      { tier: 'daily', retentionDays: 365 },
    ]);
  });

  it('uses configured values and includes optional tiers when present', () => {
    expect(
      configuredTierRetentions({
        daily: { retentionDays: 400 },
        hourly: { retentionDays: 14 },
        costOptimization: {},
      }),
    ).toEqual([
      { tier: 'daily', retentionDays: 400 },
      { tier: 'hourly', retentionDays: 14 },
      { tier: 'cost-optimization', retentionDays: 90 },
    ]);
  });

  it('omits tiers that are not configured', () => {
    const tiers = configuredTierRetentions({ daily: { retentionDays: 365 }, hourly: { retentionDays: 30 } });
    expect(tiers.map(t => t.tier)).toEqual(['daily', 'hourly']);
  });
});
