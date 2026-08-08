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

// jsdom performs no layout, so every element measures 0×0 and the real
// ResizeObserver never exists. Charts gate their SVG bodies on a measured
// container size (useContainerWidth and visx ParentSize both read
// contentRect off the first entry), so a mock that never fires keeps every
// chart body unmounted in tests. Instead, report a fixed realistic size once
// per observed element — asynchronously, like the real observer's
// first-observation notification — so charts mount their internals after
// "layout settles".
export const MOCK_CONTAINER_WIDTH = 800;
export const MOCK_CONTAINER_HEIGHT = 600;

function makeResizeEntry(target: Element): ResizeObserverEntry {
  const size: ResizeObserverSize = {
    inlineSize: MOCK_CONTAINER_WIDTH,
    blockSize: MOCK_CONTAINER_HEIGHT,
  };
  const contentRect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: MOCK_CONTAINER_WIDTH,
    height: MOCK_CONTAINER_HEIGHT,
    right: MOCK_CONTAINER_WIDTH,
    bottom: MOCK_CONTAINER_HEIGHT,
    toJSON: () => ({}),
  };
  return {
    target,
    contentRect,
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
  };
}

globalThis.ResizeObserver = class MockResizeObserver implements ResizeObserver {
  private readonly cb: ResizeObserverCallback;
  private readonly targets = new Set<Element>();
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    this.targets.add(target);
    queueMicrotask(() => {
      // Unobserved or disconnected (usually: unmounted) before the async
      // notification — don't set state on a dead component.
      if (!this.targets.has(target)) return;
      this.cb([makeResizeEntry(target)], this);
    });
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
};

// jsdom has no IntersectionObserver either. Dashboard widgets defer mounting
// until their slot is in view (widget-load-scheduler), so by default report
// every observed element as immediately intersecting — tests render all
// widgets without ceremony. Tests that exercise the visibility gate itself
// flip `setAutoIntersect(false)` and drive entries manually with
// `fireIntersections`; `afterEach` restores the default.
const intersectionObservers = new Set<MockIntersectionObserver>();
let autoIntersect = true;

export function setAutoIntersect(value: boolean): void {
  autoIntersect = value;
}

/** Deliver an intersection entry to every currently observed element. */
export function fireIntersections(isIntersecting: boolean): void {
  for (const observer of [...intersectionObservers]) {
    observer.fireAll(isIntersecting);
  }
}

class MockIntersectionObserver implements IntersectionObserver {
  private readonly cb: IntersectionObserverCallback;
  private readonly targets = new Set<Element>();
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    intersectionObservers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
    if (autoIntersect) this.fire(target, true);
  }
  fire(target: Element, isIntersecting: boolean): void {
    if (!this.targets.has(target)) return;
    const rect = target.getBoundingClientRect();
    const entry: IntersectionObserverEntry = {
      isIntersecting,
      target,
      intersectionRatio: isIntersecting ? 1 : 0,
      time: 0,
      boundingClientRect: rect,
      intersectionRect: rect,
      rootBounds: null,
    };
    this.cb([entry], this);
  }
  fireAll(isIntersecting: boolean): void {
    for (const target of [...this.targets]) this.fire(target, isIntersecting);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    intersectionObservers.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds = [];
}

globalThis.IntersectionObserver = MockIntersectionObserver;

Element.prototype.scrollIntoView = () => { /* noop */ };

afterEach(() => {
  cleanup();
  autoIntersect = true;
  intersectionObservers.clear();
});
