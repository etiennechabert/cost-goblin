import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Query results are applied inside startTransition (use-query.ts), so success
// renders are time-sliced and can land past testing-library's 1s default
// waitFor/findBy timeout on loaded CI runners, more so for data-heavy views
// (charts, large tables) that only render after a mock query resolves. Give
// async utilities more headroom. A passing assertion still resolves as soon
// as its condition is met, so this only affects genuinely slow or failing
// waits, not overall suite speed. Kept below the ui project's testTimeout —
// see the note on it in vitest.config.ts.
configure({ asyncUtilTimeout: 5000 });

// jsdom implements no matchMedia at all, so components that read a media
// query (useReducedMotion) would take their no-matchMedia fallback in every
// test and the real branch would never run. Install a minimal one.
//
// It defaults to NOT reducing motion — the setting the overwhelming majority
// of users have — so tests exercise the same path they do, matching the
// ResizeObserver/IntersectionObserver mocks below (both report the state that
// keeps components on their production path). Tests covering the
// reduced-motion branch flip `setReducedMotion(true)`; `afterEach` restores
// the default.
//
// Only `prefers-reduced-motion` is modelled; every other query reports false.
// That is a silent answer where jsdom previously threw, so a future consumer
// of a different query (a `prefers-color-scheme` or breakpoint hook) must
// extend this rather than assume the default is meaningful for it.
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
let reducedMotion = false;

// Extends EventTarget rather than hand-rolling listener bookkeeping, so
// add/removeEventListener behave like the real thing (correct DOM signatures,
// duplicate-listener and removal semantics) and `instanceof EventTarget`
// holds — a subscriber that works against this mock works against a browser.
// jsdom ships no MediaQueryListEvent constructor, so supply one. Subclassing
// Event inherits everything the interface needs beyond `matches`/`media`,
// which keeps the listener signatures identical to the real DOM ones.
class MockMediaQueryListEvent extends Event implements MediaQueryListEvent {
  readonly matches: boolean;
  readonly media: string;

  constructor(media: string, matches: boolean) {
    super('change');
    this.media = media;
    this.matches = matches;
  }
}

type LegacyListener = (this: MediaQueryList, ev: MediaQueryListEvent) => unknown;

class MockMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  onchange: LegacyListener | null = null;
  /** Wrappers registered for deprecated-API callbacks, so removeListener can
   *  unregister the same function reference addListener passed. */
  private readonly legacyWrappers = new Map<LegacyListener, EventListener>();

  constructor(media: string) {
    super();
    this.media = media;
  }

  // A getter, not a snapshot: useSyncExternalStore re-reads `matches` after
  // every change notification, off the instance it already holds.
  get matches(): boolean {
    return this.media === REDUCED_MOTION_QUERY && reducedMotion;
  }

  addListener(callback: LegacyListener | null): void {
    if (callback === null || this.legacyWrappers.has(callback)) return;
    const wrapper: EventListener = () => { callback.call(this, this.changeEvent()); };
    this.legacyWrappers.set(callback, wrapper);
    this.addEventListener('change', wrapper);
  }

  removeListener(callback: LegacyListener | null): void {
    if (callback === null) return;
    const wrapper = this.legacyWrappers.get(callback);
    if (wrapper === undefined) return;
    this.legacyWrappers.delete(callback);
    this.removeEventListener('change', wrapper);
  }

  private changeEvent(): MediaQueryListEvent {
    return new MockMediaQueryListEvent(this.media, this.matches);
  }

  /** Notify subscribers, mirroring how a browser fires the query's change
   *  event — including the `onchange` property handler. */
  notifyChange(): void {
    this.onchange?.call(this, this.changeEvent());
    this.dispatchEvent(this.changeEvent());
  }
}

// One instance per query: matchMedia is called on every getSnapshot, and a
// fresh object each time would leave the set of live lists growing unbounded
// within a test and dispatch to detached copies.
const mediaQueryLists = new Map<string, MockMediaQueryList>();

globalThis.matchMedia = (query: string): MediaQueryList => {
  const existing = mediaQueryLists.get(query);
  if (existing !== undefined) return existing;
  const created = new MockMediaQueryList(query);
  mediaQueryLists.set(query, created);
  return created;
};

/** Set the reduced-motion preference the suite reports, dispatching `change`
 *  to anything subscribed — so a component using useReducedMotion reacts as it
 *  would to a real OS toggle, not just at its next mount. */
export function setReducedMotion(value: boolean): void {
  if (reducedMotion === value) return;
  reducedMotion = value;
  mediaQueryLists.get(REDUCED_MOTION_QUERY)?.notifyChange();
}

// jsdom performs no layout, so every element measures 0×0 and the real
// ResizeObserver never exists. Charts gate their SVG bodies on a measured
// container size (useContainerWidth and visx ParentSize both read
// contentRect off the first entry), so a mock that never fires keeps every
// chart body unmounted in tests. Instead, report a fixed realistic size once
// per observed element — asynchronously, like the real observer's
// first-observation notification — so charts mount their internals after
// "layout settles".
const MOCK_CONTAINER_WIDTH = 800;
const MOCK_CONTAINER_HEIGHT = 600;

// Every mocked resize reports the same fixed size — only `target` varies per
// entry — so build the size/rect once and share them across every entry.
const MOCK_SIZE: ResizeObserverSize = {
  inlineSize: MOCK_CONTAINER_WIDTH,
  blockSize: MOCK_CONTAINER_HEIGHT,
};
const MOCK_SIZES: ReadonlyArray<ResizeObserverSize> = [MOCK_SIZE];
const MOCK_CONTENT_RECT: DOMRectReadOnly = {
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

function makeResizeEntry(target: Element): ResizeObserverEntry {
  return {
    target,
    contentRect: MOCK_CONTENT_RECT,
    borderBoxSize: MOCK_SIZES,
    contentBoxSize: MOCK_SIZES,
    devicePixelContentBoxSize: MOCK_SIZES,
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
  private makeEntry(target: Element, isIntersecting: boolean): IntersectionObserverEntry {
    const rect = target.getBoundingClientRect();
    return {
      isIntersecting,
      target,
      intersectionRatio: isIntersecting ? 1 : 0,
      time: 0,
      boundingClientRect: rect,
      intersectionRect: rect,
      rootBounds: null,
    };
  }
  fire(target: Element, isIntersecting: boolean): void {
    if (!this.targets.has(target)) return;
    this.cb([this.makeEntry(target, isIntersecting)], this);
  }
  // Deliver every observed target in a single callback, like the real
  // IntersectionObserver, so a callback that disconnect()s mid-batch can't
  // cause the remaining targets to be silently dropped.
  fireAll(isIntersecting: boolean): void {
    const entries = [...this.targets].map((target) => this.makeEntry(target, isIntersecting));
    if (entries.length > 0) this.cb(entries, this);
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
  reducedMotion = false;
  mediaQueryLists.clear();
});
