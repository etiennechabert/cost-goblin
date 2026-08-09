import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** True when the environment exposes matchMedia — false under jsdom without
 *  the test shim, and in the node-environment vitest projects that import UI
 *  modules for their types. */
function canMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function getSnapshot(): boolean {
  if (!canMatchMedia()) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (!canMatchMedia()) return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => { query.removeEventListener('change', onChange); };
}

/** Tracks the OS-level "reduce motion" accessibility preference, staying
 *  subscribed so a mid-session toggle takes effect immediately rather than at
 *  the next mount. Components that animate should skip their animation — and
 *  any `will-change` hints that go with it — when this is true. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
