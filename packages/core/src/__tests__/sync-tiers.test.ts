import { describe, expect, it } from 'vitest';
import { getEtagFileName, getRawDirPrefix } from '../sync/tiers.js';

describe('getEtagFileName', () => {
  it('maps each tier to its own sidecar file', () => {
    expect(getEtagFileName('daily')).toBe('sync-etags.json');
    expect(getEtagFileName('hourly')).toBe('sync-etags-hourly.json');
    expect(getEtagFileName('cost-optimization')).toBe('sync-etags-cost-optimization.json');
  });

  it('falls back to the daily sidecar for an unknown tier', () => {
    expect(getEtagFileName('weekly')).toBe('sync-etags.json');
  });
});

describe('getRawDirPrefix', () => {
  it('maps each tier to its raw dir prefix — cost-optimization is shortened', () => {
    expect(getRawDirPrefix('daily')).toBe('daily');
    expect(getRawDirPrefix('hourly')).toBe('hourly');
    expect(getRawDirPrefix('cost-optimization')).toBe('cost-opt');
  });

  it('falls back to the daily prefix for an unknown tier', () => {
    expect(getRawDirPrefix('weekly')).toBe('daily');
  });
});
