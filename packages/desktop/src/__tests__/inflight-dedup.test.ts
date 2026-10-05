import { describe, it, expect, vi } from 'vitest';
import { InflightDedup } from '../main/inflight-dedup.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** One macrotask: long enough for Node to have emitted any unhandledRejection
 *  for promises rejected (and left unobserved) before it. */
function flushRejectionTracking(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('InflightDedup', () => {
  it('shares one run among concurrent callers of a key, and only that key', async () => {
    const dedup = new InflightDedup<string>();
    const runs: string[] = [];
    const run = (tag: string) => (): Promise<string> => { runs.push(tag); return Promise.resolve(tag); };

    const a = dedup.run('k', run('first'));
    const b = dedup.run('k', run('second'));
    const other = dedup.run('other', run('other'));

    expect(b).toBe(a);
    expect(runs).toEqual(['first', 'other']);
    expect(await b).toBe('first');
    expect(await other).toBe('other');
  });

  it('rejects every caller sharing a failed run, then lets the key run again', async () => {
    const dedup = new InflightDedup<string>();
    let calls = 0;
    const run = (): Promise<string> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('Query cancelled')) : Promise.resolve('fresh');
    };

    const a = dedup.run('k', run);
    const b = dedup.run('k', run);
    await expect(a).rejects.toThrow('Query cancelled');
    await expect(b).rejects.toThrow('Query cancelled');

    // The failed run is no longer in flight: the next call starts a new one.
    await expect(dedup.run('k', run)).resolves.toBe('fresh');
    expect(calls).toBe(2);
  });

  it('raises no process-level unhandledRejection when a shared run fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const dedup = new InflightDedup<string>();
      // A navigation burst: several callers share each cancelled query.
      const cancelled = (): Promise<string> => Promise.reject(new Error('Query cancelled'));
      const callers = [
        dedup.run('q1', cancelled),
        dedup.run('q1', cancelled),
        dedup.run('q2', cancelled),
      ];
      const settled = await Promise.allSettled(callers);
      expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected', 'rejected']);

      await flushRejectionTracking();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('does not let a run that settles after clear() evict its successor', async () => {
    const dedup = new InflightDedup<string>();
    const stale = deferred<string>();
    const fresh = deferred<string>();
    let calls = 0;

    void dedup.run('k', () => { calls += 1; return stale.promise; });
    dedup.clear();
    const successor = dedup.run('k', () => { calls += 1; return fresh.promise; });
    expect(calls).toBe(2);

    stale.resolve('stale');
    await flushRejectionTracking();

    // The successor is still in flight, so a new caller joins it.
    expect(dedup.run('k', () => { calls += 1; return Promise.resolve('third'); })).toBe(successor);
    expect(calls).toBe(2);
    fresh.resolve('fresh');
    expect(await successor).toBe('fresh');
  });
});
