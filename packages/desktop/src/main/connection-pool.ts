/**
 * Generic FIFO resource pool. Acquire returns an idle resource or a Promise
 * that resolves when one is released. Release hands the resource directly
 * to the first waiter, or returns it to the idle stack if none.
 *
 * Shape is deliberately minimal — no timeouts, no invalidation, no draining.
 * Callers are expected to always release. For DuckDB connections in our
 * worker, the connections live for the lifetime of the process.
 */
export interface ResourcePool<T> {
  acquire(): Promise<T>;
  release(resource: T): void;
}

export async function createResourcePool<T>(
  size: number,
  factory: () => Promise<T>,
): Promise<ResourcePool<T>> {
  const idle: T[] = [];
  for (let i = 0; i < size; i++) {
    idle.push(await factory());
  }
  const waiters: ((resource: T) => void)[] = [];

  return {
    acquire(): Promise<T> {
      const resource = idle.pop();
      if (resource !== undefined) return Promise.resolve(resource);
      return new Promise<T>(resolve => waiters.push(resolve));
    },
    release(resource: T): void {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(resource);
      else idle.push(resource);
    },
  };
}
