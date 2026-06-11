import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Query results are applied inside startTransition (use-query.ts), so
// success renders are time-sliced and can land past testing-library's 1s
// default waitFor/findBy timeout on loaded CI runners — especially while
// an urgent loader animation keeps preempting the deferred commit. 3s
// stays comfortably above the deferral without masking real hangs
// (vitest's own 5s per-test cap still applies).
configure({ asyncUtilTimeout: 3000 });

globalThis.ResizeObserver = class ResizeObserver {
  observe() { /* noop */ }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
};

Element.prototype.scrollIntoView = () => { /* noop */ };

afterEach(() => {
  cleanup();
});
