import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryCache } from '../query/cache.js';

describe('QueryCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves values', () => {
    const cache = new QueryCache(30);
    cache.set('key1', { data: 'test' });
    expect(cache.get('key1')).toEqual({ data: 'test' });
  });

  it('returns undefined for missing keys', () => {
    const cache = new QueryCache(30);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    const cache = new QueryCache(1);
    cache.set('key1', 'value');
    expect(cache.get('key1')).toBe('value');

    vi.advanceTimersByTime(61 * 1000);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('invalidates all entries', () => {
    const cache = new QueryCache(30);
    cache.set('key1', 'a');
    cache.set('key2', 'b');
    cache.invalidate();
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBeUndefined();
  });

  it('evicts oldest entry when at max size', () => {
    const cache = new QueryCache(30, 2);
    cache.set('key1', 'a');
    cache.set('key2', 'b');
    cache.set('key3', 'c');
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBe('b');
    expect(cache.get('key3')).toBe('c');
  });

  it('builds deterministic cache keys', () => {
    const cache = new QueryCache(30);
    const params = { groupBy: 'service', dateRange: { start: '2026-01-01', end: '2026-01-31' } };
    const key1 = cache.buildKey(params);
    const key2 = cache.buildKey(params);
    expect(key1).toBe(key2);
  });
});
