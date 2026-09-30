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
 *      small concurrency cap — a widget holds its lane until every query it
 *      started has settled (tracked via `useWidgetSlot()` from the shared
 *      `useQuery` hook), or until it unmounts.
 *
 * Off-screen widgets never query until scrolled to; visible ones load
 * top-to-bottom a few at a time instead of all at once.
 */

const DEFAULT_MAX_CONCURRENT = 3;
/** Preload a bit before the slot is actually on screen so scrolling feels instant. */
const DEFAULT_ROOT_MARGIN = '400px';
/** Safety net: if a mounted widget never settles (no query, or one hangs),
 *  free its lane anyway so the queue can't stall. */
const SLOT_RELEASE_FALLBACK_MS = 5000;

// ---------------------------------------------------------------------------
// Per-slot handle — the shared useQuery hook tracks each query it runs, so the
// slot frees its lane only once ALL of the widget's queries have settled.
// ---------------------------------------------------------------------------
export interface WidgetSlotHandle {
  /** Record that one of the widget's queries started. Returns its `done`
   *  callback (idempotent): call it once that query's settled state has
   *  committed, or when the query is abandoned (deps changed, unmounted). */
  readonly trackQuery: () => () => void;
}

const WidgetSlotContext = createContext<WidgetSlotHandle | null>(null);

/** Read the current widget slot (null outside a `LazyWidgetSlot`). The shared
 *  `useQuery` hook uses this to report its queries to the scheduler. */
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
/** One slot's request for a lane. Keyed by identity, not widget id, so a stale
 *  release from an unmounted slot can never free a newer request's lane. */
interface SlotTicket {
  readonly priority: number;
  /** Called (from the provider's effect) when the ticket is granted a lane. */
  readonly grant: () => void;
}

interface SchedulerApi {
  /** Queue `ticket`; granted in ascending `priority` up to the concurrency cap. */
  readonly request: (ticket: SlotTicket) => void;
  /** Drop `ticket`: withdraw it if still queued, free its lane if granted.
   *  Idempotent, and a no-op for a ticket that holds no lane. */
  readonly release: (ticket: SlotTicket) => void;
}

const SchedulerContext = createContext<SchedulerApi | null>(null);

export function WidgetSchedulerProvider({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  children,
}: Readonly<{ maxConcurrent?: number; children: ReactNode }>): React.JSX.Element {
  const [version, setVersion] = useState(0);
  const pendingRef = useRef<Set<SlotTicket>>(new Set()); // queued, not yet granted
  const activeRef = useRef<Set<SlotTicket>>(new Set());  // occupying a lane

  // Pump after the commit, so all slot requests from this render are collected
  // before granting — that lets the scheduler honor `priority` rather than
  // whichever slot's effect happened to run first.
  useEffect(() => {
    while (activeRef.current.size < maxConcurrent) {
      let best: SlotTicket | null = null;
      for (const ticket of pendingRef.current) {
        if (best === null || ticket.priority < best.priority) best = ticket;
      }
      if (best === null) break;
      pendingRef.current.delete(best);
      activeRef.current.add(best);
      best.grant();
    }
  }, [version, maxConcurrent]);

  const request = useCallback((ticket: SlotTicket) => {
    pendingRef.current.add(ticket);
    setVersion(v => v + 1);
  }, []);

  const release = useCallback((ticket: SlotTicket) => {
    pendingRef.current.delete(ticket);
    if (activeRef.current.delete(ticket)) setVersion(v => v + 1);
  }, []);

  // Stable for the provider's lifetime: grants reach only the granted slot (via
  // its ticket), so a grant never re-renders the other mounted widgets.
  const value = useMemo<SchedulerApi>(() => ({ request, release }), [request, release]);
  return <SchedulerContext.Provider value={value}>{children}</SchedulerContext.Provider>;
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------
/** A widget slot that defers mounting `children` until the slot scrolls into
 *  view and the scheduler grants it a turn. Reserves `minHeight` while deferred
 *  so layout doesn't jump (and charts get a sized container on mount).
 *  `priority` is read once, when the slot first comes into view. */
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
  const [granted, setGranted] = useState(false);
  const ticketRef = useRef<SlotTicket | null>(null);
  const priorityRef = useRef(priority);
  priorityRef.current = priority;

  // Without a scheduler (e.g. a standalone render), fall back to pure viewport gating.
  const isMounted = scheduler === null ? inView : granted;

  // Queue for a lane once in view, and give it back on unmount — whether the
  // ticket is still queued or its widget is mid-load. Leaving it behind would
  // pin the lane (or let a later pump grant it to a slot that no longer exists)
  // for as long as the provider lives, which spans dashboard switches.
  useEffect(() => {
    if (scheduler === null || !inView) return undefined;
    const ticket: SlotTicket = { priority: priorityRef.current, grant: () => { setGranted(true); } };
    ticketRef.current = ticket;
    scheduler.request(ticket);
    return () => {
      ticketRef.current = null;
      scheduler.release(ticket);
    };
  }, [scheduler, inView]);

  // Hold the lane until every query the widget started has settled — not just
  // the first: a widget's instant no-op query (e.g. its Compare query with
  // Compare off) would otherwise free the lane while the real one still runs.
  const inFlightRef = useRef(0);
  const slotHandle = useMemo<WidgetSlotHandle>(() => ({
    trackQuery: () => {
      inFlightRef.current += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        inFlightRef.current -= 1;
        if (inFlightRef.current > 0) return;
        // A restarting query (deps change, cancel-retry) is untracked and
        // re-tracked within one effect flush; let that flush finish so the
        // momentary zero doesn't free the lane.
        queueMicrotask(() => {
          const ticket = ticketRef.current;
          if (inFlightRef.current === 0 && ticket !== null) scheduler?.release(ticket);
        });
      };
    },
  }), [scheduler]);

  // Safety net so a non-settling widget can't block the queue forever.
  useEffect(() => {
    const ticket = ticketRef.current;
    if (!isMounted || scheduler === null || ticket === null) return undefined;
    const timer = setTimeout(() => { scheduler.release(ticket); }, SLOT_RELEASE_FALLBACK_MS);
    return () => { clearTimeout(timer); };
  }, [isMounted, scheduler]);

  // The data attributes are a stable hook for e2e measurement (stress.test.ts
  // names the widget that grew and waits for every slot to mount).
  return (
    <div
      ref={ref}
      className={className}
      style={style}
      data-widget-id={id}
      data-widget-state={isMounted ? 'mounted' : 'deferred'}
    >
      {isMounted
        ? <WidgetSlotContext.Provider value={slotHandle}>{children}</WidgetSlotContext.Provider>
        : <div aria-hidden style={{ minHeight }} />}
    </div>
  );
}
