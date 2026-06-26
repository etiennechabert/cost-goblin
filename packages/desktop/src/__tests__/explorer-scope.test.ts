import { describe, expect, it } from 'vitest';
import { resolveScopeMetric, resolveScopePerspective, pickMetric, pickPerspective } from '../main/handlers/explorer-scope.js';

// Columns present in a full CUR export (resource IDs + net + list price).
const FULL = new Set([
  'reservation_effective_cost',
  'savings_plan_savings_plan_effective_cost',
  'pricing_public_on_demand_cost',
  'line_item_net_unblended_cost',
]);
// A minimal CUR with none of the optional columns.
const BARE = new Set<string>();

describe('pickMetric capability gate', () => {
  it('keeps a supported metric and degrades an unsupported one to unblended', () => {
    expect(pickMetric('list', FULL)).toBe('list');
    expect(pickMetric('amortized', FULL)).toBe('amortized');
    expect(pickMetric('list', BARE)).toBe('unblended');
    expect(pickMetric('amortized', BARE)).toBe('unblended');
    expect(pickMetric(undefined, FULL)).toBe('unblended');
  });
});

describe('resolveScopeMetric', () => {
  it('inherits the scope metric when applyCostScope and no explicit override (the dashboard-widget case)', () => {
    expect(resolveScopeMetric(undefined, true, { costMetric: 'list' }, FULL)).toBe('list');
    expect(resolveScopeMetric(undefined, true, { costMetric: 'amortized' }, FULL)).toBe('amortized');
  });

  it('does NOT inherit when applyCostScope is false (no scope requested)', () => {
    expect(resolveScopeMetric(undefined, false, { costMetric: 'list' }, FULL)).toBe('unblended');
  });

  it('lets an explicit metric win over the scope (the Explorer-view case)', () => {
    expect(resolveScopeMetric('unblended', true, { costMetric: 'list' }, FULL)).toBe('unblended');
    expect(resolveScopeMetric('amortized', true, { costMetric: 'list' }, FULL)).toBe('amortized');
  });

  it('still capability-gates an inherited metric the CUR cannot support', () => {
    expect(resolveScopeMetric(undefined, true, { costMetric: 'list' }, BARE)).toBe('unblended');
  });

  it('falls back to unblended when there is no scope', () => {
    expect(resolveScopeMetric(undefined, true, undefined, FULL)).toBe('unblended');
  });
});

describe('pickPerspective capability gate', () => {
  it('keeps net only when the net column exists', () => {
    expect(pickPerspective('net', FULL)).toBe('net');
    expect(pickPerspective('net', BARE)).toBe('gross');
    expect(pickPerspective(undefined, FULL)).toBe('gross');
  });
});

describe('resolveScopePerspective', () => {
  it('inherits the scope perspective when applyCostScope and no override', () => {
    expect(resolveScopePerspective(undefined, true, { costPerspective: 'net' }, FULL)).toBe('net');
  });

  it('does NOT inherit when applyCostScope is false', () => {
    expect(resolveScopePerspective(undefined, false, { costPerspective: 'net' }, FULL)).toBe('gross');
  });

  it('lets an explicit perspective win and stays capability-gated', () => {
    expect(resolveScopePerspective('gross', true, { costPerspective: 'net' }, FULL)).toBe('gross');
    expect(resolveScopePerspective(undefined, true, { costPerspective: 'net' }, BARE)).toBe('gross');
  });
});
