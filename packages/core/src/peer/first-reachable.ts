import { setMaxListeners } from 'node:events';

export type FirstReachableResult<C, T> =
  | { readonly status: 'reached'; readonly candidate: C; readonly value: T }
  /** One error per candidate, in candidate order (not completion order). */
  | { readonly status: 'unreachable'; readonly errors: readonly unknown[] };

/** Try every candidate at once and settle on the first that succeeds.
 *
 *  A sharing key lists all of the publisher's addresses (LAN, VPN, Tailscale…)
 *  and only one may route from where the consumer is. Off its own network, an
 *  address usually swallows the connection rather than refusing it, so trying
 *  them one after another stalled a full timeout on each dead one before
 *  reaching, say, the Tailscale address. In parallel, the wait is the fastest
 *  success — or the slowest failure when none answers.
 *
 *  Once one succeeds, the shared signal aborts the attempts still in flight. */
export async function firstReachable<C, T>(
  candidates: readonly C[],
  attempt: (candidate: C, signal: AbortSignal) => Promise<T>,
): Promise<FirstReachableResult<C, T>> {
  const controller = new AbortController();
  // One abort listener per attempt in flight: past Node's default of 10 that
  // reads as a leak warning, yet a host with many interfaces is legitimate.
  setMaxListeners(Math.max(10, candidates.length), controller.signal);
  try {
    // Started together; the async wrapper turns an attempt that throws
    // instead of rejecting into a failed candidate. AggregateError keeps the
    // errors in candidate order.
    return await Promise.any(candidates.map(async (candidate): Promise<FirstReachableResult<C, T>> =>
      ({ status: 'reached', candidate, value: await attempt(candidate, controller.signal) })));
  } catch (err: unknown) {
    if (err instanceof AggregateError) return { status: 'unreachable', errors: err.errors };
    throw err;
  } finally {
    controller.abort();
  }
}
