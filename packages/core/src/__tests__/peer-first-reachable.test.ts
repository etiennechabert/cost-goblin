import { describe, expect, it } from 'vitest';
import { firstReachable } from '../peer/first-reachable.js';

function after<T>(ms: number, outcome: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(outcome()); } catch (err: unknown) { reject(err instanceof Error ? err : new Error(String(err))); }
    }, ms);
  });
}

describe('firstReachable', () => {
  it('resolves with the first candidate to succeed, not the first listed', async () => {
    const result = await firstReachable(['lan', 'tailscale'], (host) =>
      host === 'lan' ? after(200, () => 'lan-manifest') : after(5, () => 'tailscale-manifest'));
    expect(result).toEqual({ status: 'reached', candidate: 'tailscale', value: 'tailscale-manifest' });
  });

  it('starts every attempt at once instead of waiting for each to fail', async () => {
    const started: string[] = [];
    const pending = firstReachable(['a', 'b', 'c'], (host) => {
      started.push(host);
      return after(20, () => host);
    });
    expect(started).toEqual(['a', 'b', 'c']);
    await pending;
  });

  it('aborts the attempts still in flight once one succeeds', async () => {
    const signals = new Map<string, AbortSignal>();
    await firstReachable(['slow', 'fast'], (host, signal) => {
      signals.set(host, signal);
      return host === 'fast' ? after(5, () => host) : after(500, () => host);
    });
    expect(signals.get('slow')?.aborted).toBe(true);
  });

  it('keeps waiting for a slower success when another candidate fails fast', async () => {
    const result = await firstReachable(['refused', 'slow'], (host) =>
      host === 'refused' ? after(1, () => { throw new Error('ECONNREFUSED'); }) : after(30, () => 'ok'));
    expect(result).toEqual({ status: 'reached', candidate: 'slow', value: 'ok' });
  });

  it('reports every failure in candidate order, not completion order', async () => {
    const result = await firstReachable(['first', 'second'], (host) =>
      after(host === 'first' ? 30 : 1, () => { throw new Error(`${host} failed`); }));
    expect(result.status).toBe('unreachable');
    if (result.status !== 'unreachable') return;
    expect(result.errors.map(e => (e instanceof Error ? e.message : String(e)))).toEqual(['first failed', 'second failed']);
  });

  it('treats an attempt that throws synchronously as a failed candidate', async () => {
    const result = await firstReachable(['bad', 'good'], (host) => {
      if (host === 'bad') throw new Error('bad host');
      return after(1, () => 'ok');
    });
    expect(result).toEqual({ status: 'reached', candidate: 'good', value: 'ok' });
  });

  it('is unreachable with no errors when there is no candidate', async () => {
    expect(await firstReachable([], () => Promise.resolve('never'))).toEqual({ status: 'unreachable', errors: [] });
  });
});
