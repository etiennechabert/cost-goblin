interface CacheEntry {
  readonly value: unknown;
  readonly timestamp: number;
}

export class QueryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMinutes: number, maxSize: number = 100) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.maxSize = maxSize;
  }

  get(key: string): unknown {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown): void {
    if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { value, timestamp: Date.now() });
  }

  invalidate(): void {
    this.entries.clear();
  }

  buildKey(params: unknown): string {
    return JSON.stringify(params);
  }
}
