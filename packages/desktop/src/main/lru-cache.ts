/**
 * Generic LRU (Least Recently Used) cache with automatic eviction.
 *
 * Uses a Map to track insertion order; when an item is accessed, it's
 * deleted and re-inserted to move it to the end (most recent).
 * When the cache reaches maxSize, the oldest (first) entry is evicted.
 */
export class LRUCache<K, V> {
  private readonly maxSize: number;
  private readonly cache: Map<K, V>;

  constructor(maxSize: number) {
    if (maxSize < 0) {
      throw new Error('LRUCache maxSize must be non-negative');
    }
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  /**
   * Retrieves a value from the cache and marks it as recently used.
   * Returns undefined if the key is not in the cache.
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Move to end by deleting and re-inserting
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Adds or updates a value in the cache.
   * If the cache is full, evicts the least recently used entry first.
   */
  set(key: K, value: V): void {
    // If key already exists, delete it first so re-insertion moves it to the end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest entry if we're at capacity and this is a new key
    if (this.cache.size >= this.maxSize && this.maxSize > 0) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    // Only insert if maxSize > 0
    if (this.maxSize > 0) {
      this.cache.set(key, value);
    }
  }

  /**
   * Checks if a key exists in the cache without updating access order.
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Removes a specific entry from the cache.
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Removes all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Returns the current number of entries in the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Returns an iterator over the cache entries in access order
   * (least recently used first).
   */
  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }

  /**
   * Returns an iterator over the cache keys in access order
   * (least recently used first).
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  /**
   * Returns an iterator over the cache values in access order
   * (least recently used first).
   */
  values(): IterableIterator<V> {
    return this.cache.values();
  }
}
