import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// CI runners are slower than dev machines, and the default 1000ms async timeout
// for waitFor/findBy is borderline for data-heavy views (charts, large tables)
// that only render after a mock query resolves — causing flaky timeouts that
// don't reproduce locally. Give async utilities more headroom. A passing
// assertion still resolves as soon as its condition is met, so this only
// affects genuinely slow or failing waits, not overall suite speed.
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
