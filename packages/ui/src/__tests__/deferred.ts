import { act } from '@testing-library/react';

/** Hand-settled promises, shared by the suites that drive loading, saving and
 *  late-answer states. */

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** A promise the test settles by hand — for loading/saving states. */
export function deferred<T>(): Deferred<T> {
  let settle: { resolve: (value: T) => void; reject: (reason: unknown) => void } | null = null;
  const promise = new Promise<T>((resolve, reject) => { settle = { resolve, reject }; });
  return {
    promise,
    resolve(value) { settle?.resolve(value); },
    reject(reason) { settle?.reject(reason); },
  };
}

/** A promise already rejected with `reason` — which, like a failed IPC call,
 *  need not be an Error. It is marked handled up front: a test often builds
 *  it before the call that consumes it (`mockReturnValue(rejectWith(…))`),
 *  and Node would report the rejection as unhandled in between. Whoever
 *  awaits it still sees it reject. */
export function rejectWith(reason: unknown): Promise<never> {
  const d = deferred<never>();
  d.reject(reason);
  void d.promise.catch(() => undefined);
  return d.promise;
}

/** Resolve a pending query result and let React commit what it renders. */
export async function settle<T>(pending: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
  });
}
