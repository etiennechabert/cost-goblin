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

// jsdom has no IntersectionObserver. Dashboard widgets defer mounting until
// their slot is in view (use-query / widget-load-scheduler), so report every
// observed element as immediately intersecting — keeps tests rendering all
// widgets as before.
globalThis.IntersectionObserver = class IntersectionObserver {
  private readonly cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) { this.cb = cb; }
  observe(target: Element): void {
    const rect = target.getBoundingClientRect();
    const entry: IntersectionObserverEntry = {
      isIntersecting: true,
      target,
      intersectionRatio: 1,
      time: 0,
      boundingClientRect: rect,
      intersectionRect: rect,
      rootBounds: null,
    };
    this.cb([entry], this);
  }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds = [];
};

Element.prototype.scrollIntoView = () => { /* noop */ };

afterEach(() => {
  cleanup();
});
