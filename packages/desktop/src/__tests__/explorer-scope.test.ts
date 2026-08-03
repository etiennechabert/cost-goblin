import { describe, expect, it } from 'vitest';
import { resolveScopeMetric } from '../main/handlers/explorer-scope.js';

// FOCUS 1.2 pins all four cost columns, so the CUR-era capability gating
// (pickMetric/pickPerspective against a probed column set) is gone — the
// resolver is pure inheritance now, and the perspective axis no longer exists.

describe('resolveScopeMetric', () => {
  it('inherits the scope metric when applyCostScope and no explicit override (the dashboard-widget case)', () => {
    expect(resolveScopeMetric(undefined, true, { costMetric: 'list' })).toBe('list');
    expect(resolveScopeMetric(undefined, true, { costMetric: 'effective' })).toBe('effective');
  });

  it('does NOT inherit when applyCostScope is false (no scope requested)', () => {
    expect(resolveScopeMetric(undefined, false, { costMetric: 'list' })).toBe('billed');
  });

  it('lets an explicit metric win over the scope (the Explorer-view case)', () => {
    expect(resolveScopeMetric('billed', true, { costMetric: 'list' })).toBe('billed');
    expect(resolveScopeMetric('effective', true, { costMetric: 'list' })).toBe('effective');
    expect(resolveScopeMetric('contracted', true, { costMetric: 'list' })).toBe('contracted');
  });

  it('falls back to billed when there is no scope', () => {
    expect(resolveScopeMetric(undefined, true, undefined)).toBe('billed');
  });
});
