// Map-based LRU: delete+re-insert moves entries to the end; eviction pops the first.
export class LRUCache<K, V> {
  private readonly maxSize: number;
  private readonly cache = new Map<K, V>();

  constructor(maxSize: number) {
    if (maxSize < 0) throw new Error('LRUCache maxSize must be non-negative');
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize && this.maxSize > 0) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    if (this.maxSize > 0) this.cache.set(key, value);
  }

  has(key: K): boolean { return this.cache.has(key); }
  delete(key: K): boolean { return this.cache.delete(key); }
  clear(): void { this.cache.clear(); }
  get size(): number { return this.cache.size; }
}
