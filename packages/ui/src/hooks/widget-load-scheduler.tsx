import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Dashboard widget load coordination.
 *
 * A view can render ~8+ widgets, each of which fires its own query on mount.
 * Mounting them all at once means a burst of concurrent queries (and chart
 * renders) on a single DuckDB instance. This module makes widgets:
 *   1. mount only when their slot scrolls near the viewport (IntersectionObserver), and
 *   2. among the ones that want to mount, activate in display order with a
 *      small concurrency cap — a slot frees up as soon as its widget's query
 *      settles (reported via `useWidgetSlot()` from the shared `useQuery` hook).
 *
 * Off-screen widgets never query until scrolled to; visible ones load
 * top-to-bottom a few at a time instead of all at once.
 */

const DEFAULT_MAX_CONCURRENT = 3;
/** Preload a bit before the slot is actually on screen so scrolling feels instant. */
const DEFAULT_ROOT_MARGIN = '400px';
/** Safety net: if a mounted widget never reports settled (no query, or it
 *  hangs), free its concurrency slot anyway so the queue can't stall. */
const SLOT_RELEASE_FALLBACK_MS = 5000;

// ---------------------------------------------------------------------------
// Per-slot handle — the shared useQuery hook calls onSettled() once the
// widget's query resolves, freeing a concurrency slot for the next widget.
// ---------------------------------------------------------------------------
export interface WidgetSlotHandle {
  readonly onSettled: () => void;
}

const WidgetSlotContext = createContext<WidgetSlotHandle | null>(null);

/** Read the current widget slot (null outside a `LazyWidgetSlot`). The shared
 *  `useQuery` hook uses this to report query completion to the scheduler. */
export function useWidgetSlot(): WidgetSlotHandle | null {
  return useContext(WidgetSlotContext);
}

// ---------------------------------------------------------------------------
// Viewport observation
// ---------------------------------------------------------------------------
/** Become (and stay) true once the referenced element scrolls within
 *  `rootMargin` of the viewport. Falls back to true when IntersectionObserver
 *  is unavailable (SSR / very old engines) so content never gets stuck hidden. */
export function useInViewport(rootMargin: string = DEFAULT_ROOT_MARGIN): {
  ref: React.RefObject<HTMLDivElement | null>;
  inView: boolean;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return undefined;
    const el = ref.current;
    if (el === null) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
          break;
        }
      }
    }, { rootMargin });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, [inView, rootMargin]);

  return { ref, inView };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
interface SchedulerApi {
  /** ids that have been granted a mount (sticky — stays mounted once granted). */
  readonly mounted: ReadonlySet<string>;
  /** Ask to mount `id`; granted in ascending `priority` up to the concurrency cap. */
  readonly request: (id: string, priority: number) => void;
  /** Free `id`'s concurrency slot (it stays mounted). Idempotent. */
  readonly release: (id: string) => void;
}

const SchedulerContext = createContext<SchedulerApi | null>(null);

export function WidgetSchedulerProvider({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  children,
}: Readonly<{ maxConcurrent?: number; children: ReactNode }>): React.JSX.Element {
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [version, setVersion] = useState(0);
  const mountedRef = useRef<Set<string>>(new Set());   // granted to mount (sticky)
  const activeRef = useRef<Set<string>>(new Set());    // occupying a concurrency slot
  const pendingRef = useRef<Map<string, number>>(new Map()); // id -> priority
  const settledRef = useRef<Set<string>>(new Set());   // released (slot freed)

  const pump = useCallback(() => {
    let changed = false;
    while (activeRef.current.size < maxConcurrent && pendingRef.current.size > 0) {
      let bestId: string | null = null;
      let bestPriority = Number.POSITIVE_INFINITY;
      for (const [id, priority] of pendingRef.current) {
        if (priority < bestPriority) { bestPriority = priority; bestId = id; }
      }
      if (bestId === null) break;
      pendingRef.current.delete(bestId);
      activeRef.current.add(bestId);
      mountedRef.current.add(bestId);
      changed = true;
    }
    if (changed) setMounted(new Set(mountedRef.current));
  }, [maxConcurrent]);

  // Pump after the commit, so all slot requests from this render are collected
  // before granting — that lets the scheduler honor `priority` rather than
  // whichever slot's effect happened to run first.
  useEffect(() => { pump(); }, [version, pump]);

  const request = useCallback((id: string, priority: number) => {
    if (mountedRef.current.has(id) || pendingRef.current.has(id)) return;
    pendingRef.current.set(id, priority);
    setVersion(v => v + 1);
  }, []);

  const release = useCallback((id: string) => {
    if (settledRef.current.has(id)) return;
    settledRef.current.add(id);
    pendingRef.current.delete(id);
    activeRef.current.delete(id); // free the slot; id stays in mountedRef
    setVersion(v => v + 1);
  }, []);

  const value = useMemo<SchedulerApi>(() => ({ mounted, request, release }), [mounted, request, release]);
  return <SchedulerContext.Provider value={value}>{children}</SchedulerContext.Provider>;
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------
/** A widget slot that defers mounting `children` until the slot scrolls into
 *  view and the scheduler grants it a turn. Reserves `minHeight` while deferred
 *  so layout doesn't jump (and charts get a sized container on mount). */
export function LazyWidgetSlot({
  id,
  priority,
  minHeight,
  className,
  style,
  children,
}: Readonly<{
  id: string;
  priority: number;
  minHeight: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}>): React.JSX.Element {
  const scheduler = useContext(SchedulerContext);
  const { ref, inView } = useInViewport();
  const requestedRef = useRef(false);

  // Without a scheduler (e.g. a standalone render), fall back to pure viewport gating.
  const isMounted = scheduler === null ? inView : scheduler.mounted.has(id);

  useEffect(() => {
    if (scheduler === null || !inView || requestedRef.current) return;
    requestedRef.current = true;
    scheduler.request(id, priority);
  }, [scheduler, inView, id, priority]);

  // Free the concurrency slot once the widget's query settles.
  const slotHandle = useMemo<WidgetSlotHandle>(
    () => ({ onSettled: () => { scheduler?.release(id); } }),
    [scheduler, id],
  );

  // Safety net so a non-settling widget can't block the queue forever.
  useEffect(() => {
    if (!isMounted || scheduler === null) return undefined;
    const timer = setTimeout(() => { scheduler.release(id); }, SLOT_RELEASE_FALLBACK_MS);
    return () => { clearTimeout(timer); };
  }, [isMounted, scheduler, id]);

  return (
    <div ref={ref} className={className} style={style}>
      {isMounted
        ? <WidgetSlotContext.Provider value={slotHandle}>{children}</WidgetSlotContext.Provider>
        : <div aria-hidden style={{ minHeight }} />}
    </div>
  );
}
