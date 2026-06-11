import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Query results are applied inside startTransition (use-query.ts), so success
// renders are time-sliced and can land past testing-library's 1s default
// waitFor/findBy timeout on loaded CI runners, especially while an urgent
// loader animation keeps preempting the deferred commit, and more so for
// data-heavy views (charts, large tables) that only render after a mock query
// resolves. Give async utilities more headroom. A passing assertion still
// resolves as soon as its condition is met, so this only affects genuinely
// slow or failing waits, not overall suite speed.
configure({ asyncUtilTimeout: 5000 });

globalThis.ResizeObserver = class ResizeObserver {
  observe() { /* noop */ }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
};

Element.prototype.scrollIntoView = () => { /* noop */ };

afterEach(() => {
  cleanup();
});
