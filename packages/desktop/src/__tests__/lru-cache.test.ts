import { describe, it, expect } from 'vitest';
import { LRUCache } from '../main/lru-cache.js';

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts oldest entry when full', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('get promotes entry so it is not evicted next', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');
    cache.set('d', 4);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('set of existing key promotes it', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('a', 42);
    cache.set('d', 4);
    expect(cache.get('a')).toBe(42);
    expect(cache.get('b')).toBeUndefined();
  });

  it('clear removes all entries', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('generation advances on every clear, and only on clear', () => {
    // A writer that started before a clear must not re-cache what it read
    // (context.ts compares the generation it started under before set()).
    const cache = new LRUCache<string, number>(3);
    const start = cache.generation;
    cache.set('a', 1);
    cache.get('a');
    cache.delete('a');
    expect(cache.generation).toBe(start);
    cache.clear();
    expect(cache.generation).toBe(start + 1);
    cache.clear();
    expect(cache.generation).toBe(start + 2);
  });

  it('maxSize 0 stores nothing', () => {
    const cache = new LRUCache<string, number>(0);
    cache.set('a', 1);
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});
