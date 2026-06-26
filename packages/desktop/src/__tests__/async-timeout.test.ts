import { describe, it, expect } from 'vitest';
import { awaitWithTimeout } from '../main/async-timeout.js';

describe('awaitWithTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    let settled = false;
    const p = new Promise<void>((resolve) => { setTimeout(() => { settled = true; resolve(); }, 10); });
    await awaitWithTimeout(p, 1000);
    expect(settled).toBe(true);
  });

  it('resolves at the timeout when the promise hangs', async () => {
    const start = Date.now();
    await awaitWithTimeout(new Promise<void>(() => { /* never resolves */ }), 40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('does not reject when the awaited promise rejects', async () => {
    await expect(awaitWithTimeout(Promise.reject(new Error('boom')), 1000)).resolves.toBeUndefined();
  });
});
