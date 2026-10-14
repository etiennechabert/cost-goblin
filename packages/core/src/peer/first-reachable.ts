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
export function firstReachable<C, T>(
  candidates: readonly C[],
  attempt: (candidate: C, signal: AbortSignal) => Promise<T>,
): Promise<FirstReachableResult<C, T>> {
  if (candidates.length === 0) return Promise.resolve({ status: 'unreachable', errors: [] });
  const controller = new AbortController();
  const errors: unknown[] = candidates.map(() => undefined);
  let failed = 0;
  let settled = false;
  return new Promise((resolve) => {
    const succeed = (candidate: C, value: T): void => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve({ status: 'reached', candidate, value });
    };
    const fail = (i: number, err: unknown): void => {
      errors[i] = err;
      failed += 1;
      if (settled || failed < candidates.length) return;
      settled = true;
      resolve({ status: 'unreachable', errors });
    };
    candidates.forEach((candidate, i) => {
      // Started synchronously, all together. An attempt that throws instead
      // of rejecting is just a failed candidate, not an escape from the race.
      try {
        attempt(candidate, controller.signal).then((value) => { succeed(candidate, value); }, (err: unknown) => { fail(i, err); });
      } catch (err: unknown) {
        fail(i, err);
      }
    });
  });
}
