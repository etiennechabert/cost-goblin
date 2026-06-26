/** Resolve when `p` settles or after `timeoutMs` ms, whichever comes first.
 *  Never rejects — `p`'s rejection is swallowed; callers check readiness
 *  separately (e.g. via RollupStore.isReady()). Used to bound how long startup
 *  waits on the rollup warmup before falling back to raw. */
export async function awaitWithTimeout(p: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([p.then(() => undefined, () => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
