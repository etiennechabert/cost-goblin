import { describe, it, expect } from 'vitest';
import { LRUCache } from '../main/lru-cache.js';

describe('LRUCache constructor', () => {
  it('creates cache with positive maxSize', () => {
    const cache = new LRUCache<string, number>(5);
    expect(cache.size).toBe(0);
  });

  it('creates cache with maxSize 0', () => {
    const cache = new LRUCache<string, number>(0);
    expect(cache.size).toBe(0);
  });

  it('throws on negative maxSize', () => {
    expect(() => new LRUCache<string, number>(-1)).toThrow('LRUCache maxSize must be non-negative');
  });
});

describe('LRUCache basic operations', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string, number>(3);
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('updates existing keys', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('a', 42);
    expect(cache.get('a')).toBe(42);
    expect(cache.size).toBe(1);
  });

  it('tracks size correctly', () => {
    const cache = new LRUCache<string, number>(5);
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    expect(cache.size).toBe(1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
    cache.delete('a');
    expect(cache.size).toBe(1);
  });
});

describe('LRUCache has/delete', () => {
  it('checks key existence without updating access order', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('deletes entries', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.delete('nonexistent')).toBe(false);
  });
});

describe('LRUCache clear', () => {
  it('removes all entries', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
  });

  it('works on empty cache', () => {
    const cache = new LRUCache<string, number>(3);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('LRUCache eviction', () => {
  it('evicts oldest entry when full', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // should evict 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('evicts in correct order after multiple insertions', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    cache.set('d', 4); // evicts 'b'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });
});

describe('LRUCache access order', () => {
  it('updates access order on get', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Access 'a' to make it most recent
    cache.get('a');
    // Add 'd', should evict 'b' (oldest)
    cache.set('d', 4);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('updates access order on set of existing key', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Update 'a' to make it most recent
    cache.set('a', 42);
    // Add 'd', should evict 'b' (oldest)
    cache.set('d', 4);
    expect(cache.get('a')).toBe(42);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('preserves LRU order through multiple accesses', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // a is now newest
    cache.get('b'); // b is now newest, a is middle, c is oldest
    cache.set('d', 4); // should evict c
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('d')).toBe(4);
  });
});

describe('LRUCache edge cases', () => {
  it('handles maxSize of 0 (no items stored)', () => {
    const cache = new LRUCache<string, number>(0);
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('handles maxSize of 1', () => {
    const cache = new LRUCache<string, number>(1);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    cache.set('b', 2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('handles large maxSize', () => {
    const cache = new LRUCache<string, number>(1000);
    for (let i = 0; i < 1000; i++) {
      cache.set(`key${String(i)}`, i);
    }
    expect(cache.size).toBe(1000);
    cache.set('overflow', 9999);
    expect(cache.size).toBe(1000);
    expect(cache.get('key0')).toBeUndefined(); // oldest evicted
    expect(cache.get('key1')).toBe(1);
    expect(cache.get('overflow')).toBe(9999);
  });

  it('works with different key types', () => {
    const cache = new LRUCache<number, string>(3);
    cache.set(1, 'one');
    cache.set(2, 'two');
    expect(cache.get(1)).toBe('one');
    expect(cache.get(2)).toBe('two');
  });

  it('works with object values', () => {
    const cache = new LRUCache<string, { value: number }>(3);
    const obj1 = { value: 1 };
    const obj2 = { value: 2 };
    cache.set('a', obj1);
    cache.set('b', obj2);
    expect(cache.get('a')).toBe(obj1);
    expect(cache.get('b')).toBe(obj2);
  });
});

describe('LRUCache iterators', () => {
  it('returns entries in LRU order', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // move 'a' to end
    const entries = Array.from(cache.entries());
    expect(entries).toEqual([
      ['b', 2],
      ['c', 3],
      ['a', 1],
    ]);
  });

  it('returns keys in LRU order', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    const keys = Array.from(cache.keys());
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('returns values in LRU order', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    const values = Array.from(cache.values());
    expect(values).toEqual([1, 2, 3]);
  });

  it('iterators reflect current state after modifications', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    const keys = Array.from(cache.keys());
    expect(keys).toEqual(['b']);
  });
});

describe('LRUCache stress tests', () => {
  it('handles rapid set/get cycles', () => {
    const cache = new LRUCache<string, number>(10);
    for (let i = 0; i < 100; i++) {
      cache.set(`key${String(i % 15)}`, i);
    }
    expect(cache.size).toBe(10);
  });

  it('maintains integrity after mixed operations', () => {
    const cache = new LRUCache<string, number>(5);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.delete('b');
    cache.set('c', 3);
    cache.set('d', 4);
    cache.set('e', 5);
    cache.get('a');
    cache.set('f', 6);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.size).toBe(5);
  });
});
