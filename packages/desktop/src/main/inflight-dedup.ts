/** Share one in-flight run per key among concurrent callers, and only while it
 *  is in flight: once a run settles, the next call for its key starts afresh. */
export class InflightDedup<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  /** Join the run in flight for `key`, or start one with `run`. Every caller
   *  sharing a key gets the same promise, its rejection included. */
  run(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = run();
    this.inflight.set(key, promise);
    // `.then(forget, forget)`, never `.finally(forget)`: finally returns a new
    // promise that re-rejects with the run's error, and nothing holds it, so
    // every failed run (each "Query cancelled" of a navigation burst) raised a
    // process-level unhandledRejection. The callers observe `promise` itself.
    // The identity check keeps a run that outlived clear() from evicting the
    // run that replaced it under the same key.
    const forget = (): void => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    };
    promise.then(forget, forget);
    return promise;
  }

  /** Forget every in-flight run; each still settles for the callers holding it. */
  clear(): void { this.inflight.clear(); }
}
