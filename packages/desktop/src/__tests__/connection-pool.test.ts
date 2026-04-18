import { describe, it, expect } from 'vitest';
import { createResourcePool } from '../main/connection-pool.js';

describe('createResourcePool', () => {
  it('hands out idle resources immediately', async () => {
    const pool = await createResourcePool(2, () => Promise.resolve({ id: Math.random() }));
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a).not.toBe(b);
  });

  it('queues acquire calls when pool is exhausted, resolves when released', async () => {
    const pool = await createResourcePool(1, () => Promise.resolve({ id: 1 }));
    const a = await pool.acquire();

    let resolvedB = false;
    const bPromise = pool.acquire().then(r => { resolvedB = true; return r; });

    // Flush one tick — the waiter must still be blocked.
    await Promise.resolve();
    expect(resolvedB).toBe(false);

    pool.release(a);
    const b = await bPromise;
    expect(resolvedB).toBe(true);
    expect(b).toBe(a); // same resource re-used
  });

  it('releases to FIFO waiters before filling the idle stack', async () => {
    const pool = await createResourcePool(1, () => Promise.resolve({ tag: 'only' }));
    const a = await pool.acquire();

    // Two waiters queued in order.
    const order: string[] = [];
    void pool.acquire().then(() => { order.push('first'); });
    void pool.acquire().then(() => { order.push('second'); });

    // First release goes to first waiter.
    pool.release(a);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(order).toEqual(['first']);

    // Simulate that the first waiter finishes and releases — second waiter gets it.
    pool.release(a);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(order).toEqual(['first', 'second']);
  });

  it('size=1 effectively serializes concurrent work (queue guard)', async () => {
    const pool = await createResourcePool(1, () => Promise.resolve({ id: 1 }));
    const log: string[] = [];

    async function work(tag: string, ms: number): Promise<void> {
      const r = await pool.acquire();
      log.push(`${tag}:start`);
      await new Promise(resolve => setTimeout(resolve, ms));
      log.push(`${tag}:end`);
      pool.release(r);
    }

    await Promise.all([work('a', 15), work('b', 15)]);
    // With a single resource the work must not overlap.
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('size=N runs up to N in parallel', async () => {
    const pool = await createResourcePool(3, () => Promise.resolve({ id: 1 }));
    let active = 0;
    let peak = 0;

    async function work(): Promise<void> {
      const r = await pool.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      pool.release(r);
    }

    await Promise.all([work(), work(), work(), work(), work()]);
    expect(peak).toBe(3);
  });
});
