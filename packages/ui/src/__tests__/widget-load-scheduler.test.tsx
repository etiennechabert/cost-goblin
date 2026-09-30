import { StrictMode, useEffect, useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LazyWidgetSlot, WidgetSchedulerProvider, useWidgetSlot } from '../hooks/widget-load-scheduler.js';
import { useQuery } from '../hooks/use-query.js';
import { fireIntersections, setAutoIntersect } from './setup.js';

// A test widget that renders its label once mounted and holds its scheduler
// lane until clicked (standing in for "its one query settled"). `onRender`
// counts its renders.
function Child({ label, onRender }: Readonly<{ label: string; onRender?: () => void }>): React.JSX.Element {
  const slot = useWidgetSlot();
  const doneRef = useRef<(() => void) | null>(null);
  onRender?.();
  useEffect(() => {
    const done = slot?.trackQuery() ?? null;
    doneRef.current = done;
    return () => { done?.(); };
  }, [slot]);
  return <button type="button" onClick={() => { doneRef.current?.(); }}>{label}</button>;
}

// A widget backed by the real useQuery: shows `<label>-loading`, then the data.
function QueryWidget({ label, fetcher }: Readonly<{ label: string; fetcher: () => Promise<string> }>): React.JSX.Element {
  const q = useQuery(fetcher, [label]);
  return <span>{q.status === 'success' ? q.data : `${label}-loading`}</span>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const hang = (): Promise<string> => new Promise<string>(() => undefined);

/** Let pending promises, effects and scheduler pumps run their course, so an
 *  assertion that something did NOT mount isn't just racing the grant. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => { setTimeout(r, 30); }); });
}

// Widgets that must mount BEFORE the 5s fallback release (which would otherwise
// mask a leaked lane) wait at most this long — well under asyncUtilTimeout (5s).
const BEFORE_FALLBACK = { timeout: 1000 };

describe('WidgetSchedulerProvider + LazyWidgetSlot', () => {
  // The global test setup mocks IntersectionObserver as always-intersecting, so
  // every slot requests a mount immediately; the scheduler then gates them.
  it('mounts in priority order, capped, releasing as each settles', async () => {
    const user = userEvent.setup();
    render(
      <WidgetSchedulerProvider maxConcurrent={1}>
        {/* DOM order is c, a, b — but priority (0,1,2) decides load order */}
        <LazyWidgetSlot id="c" priority={2} minHeight={10}><Child label="c" /></LazyWidgetSlot>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><Child label="a" /></LazyWidgetSlot>
        <LazyWidgetSlot id="b" priority={1} minHeight={10}><Child label="b" /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );

    // cap=1 → only the highest-priority widget (a) mounts first
    expect(await screen.findByText('a')).toBeDefined();
    expect(screen.queryByText('b')).toBeNull();
    expect(screen.queryByText('c')).toBeNull();

    // a settles → b (next priority) mounts
    await user.click(screen.getByText('a'));
    expect(await screen.findByText('b')).toBeDefined();
    expect(screen.queryByText('c')).toBeNull();

    // b settles → c mounts
    await user.click(screen.getByText('b'));
    expect(await screen.findByText('c')).toBeDefined();
  });

  it('mounts multiple concurrently up to the cap', async () => {
    render(
      <WidgetSchedulerProvider maxConcurrent={2}>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><Child label="a" /></LazyWidgetSlot>
        <LazyWidgetSlot id="b" priority={1} minHeight={10}><Child label="b" /></LazyWidgetSlot>
        <LazyWidgetSlot id="c" priority={2} minHeight={10}><Child label="c" /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    expect(await screen.findByText('a')).toBeDefined();
    expect(await screen.findByText('b')).toBeDefined();
    // third stays deferred until one of the first two settles
    expect(screen.queryByText('c')).toBeNull();
  });

  it('keeps a slot unmounted until it scrolls into view', async () => {
    setAutoIntersect(false);
    const { container } = render(
      <WidgetSchedulerProvider maxConcurrent={2}>
        <LazyWidgetSlot id="a" priority={0} minHeight={240}><Child label="a" /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );

    // Off-screen: the widget never mounts; a placeholder reserves its height.
    expect(screen.queryByText('a')).toBeNull();
    const placeholder = container.querySelector('div[aria-hidden]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute('style')).toContain('min-height: 240px');

    // Scrolls into view → the scheduler grants the mount.
    act(() => { fireIntersections(true); });
    expect(await screen.findByText('a')).toBeDefined();
    expect(container.querySelector('div[aria-hidden]')).toBeNull();
  });

  it('frees a slot only once the widget has RENDERED its result, not when the promise settles', async () => {
    // useQuery applies results inside a transition. Transition updates render
    // as one batch, and an urgent update (the scheduler mounting the next
    // widget) restarts that batch. Releasing the slot on promise settle
    // therefore mounted the whole next wave before the first result painted,
    // and the first widget's data only appeared once every widget on the
    // page had loaded and rendered together — multi-second under load.
    const seenWhenNextMounted: boolean[] = [];
    // Stands in for a chart/table: a result render heavy enough that React's
    // time-sliced transition yields to the event loop part-way through, as the
    // real dashboard's does (and far more so under coverage on a loaded CI
    // runner). Several fibers, so the work loop gets a yield point between them.
    function Busy(): React.JSX.Element {
      const until = performance.now() + 8;
      while (performance.now() < until) { /* simulate render cost */ }
      return <i />;
    }
    function QueryChild({ label, onMount }: Readonly<{ label: string; onMount?: () => void }>): React.JSX.Element {
      const q = useQuery(() => {
        onMount?.();
        return Promise.resolve(`${label}-data`);
      }, [label]);
      if (q.status !== 'success') return <span>{`${label}-loading`}</span>;
      return <span>{q.data}<Busy /><Busy /><Busy /><Busy /></span>;
    }
    render(
      <WidgetSchedulerProvider maxConcurrent={1}>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><QueryChild label="a" /></LazyWidgetSlot>
        <LazyWidgetSlot id="b" priority={1} minHeight={10}>
          <QueryChild label="b" onMount={() => { seenWhenNextMounted.push(screen.queryByText('a-data') !== null); }} />
        </LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    expect(await screen.findByText('b-data')).toBeDefined();
    expect(screen.getByText('a-data')).toBeDefined();
    // b's query started only after a's result was on screen.
    expect(seenWhenNextMounted).toEqual([true]);
  });

  it('tags the slot with its widget id and mount state', async () => {
    // e2e/stress.test.ts measures every widget by these attributes, so a
    // failure can name the widget and the settle can wait on real mounts.
    setAutoIntersect(false);
    const { container } = render(
      <WidgetSchedulerProvider maxConcurrent={1}>
        <LazyWidgetSlot id="w-pie-small" priority={0} minHeight={10}><Child label="a" /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    const slot = container.querySelector('[data-widget-id="w-pie-small"]');
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute('data-widget-state')).toBe('deferred');

    act(() => { fireIntersections(true); });
    expect(await screen.findByText('a')).toBeDefined();
    expect(slot?.getAttribute('data-widget-state')).toBe('mounted');
  });

  it('frees the lane of a slot that unmounts mid-load, and never grants a queued slot that unmounted', async () => {
    // A dashboard switch: CustomView isn't keyed by view, so one provider
    // outlives the first dashboard's slots. `a` unmounts mid-query holding the
    // only lane; `b` unmounts while still queued for it.
    const { rerender } = render(
      <WidgetSchedulerProvider maxConcurrent={1}>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><QueryWidget label="a" fetcher={hang} /></LazyWidgetSlot>
        <LazyWidgetSlot id="b" priority={1} minHeight={10}><QueryWidget label="b" fetcher={hang} /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    expect(await screen.findByText('a-loading')).toBeDefined();
    expect(screen.queryByText('b-loading')).toBeNull();

    const c = deferred<string>();
    rerender(
      <WidgetSchedulerProvider maxConcurrent={1}>
        <LazyWidgetSlot id="c" priority={0} minHeight={10}><QueryWidget label="c" fetcher={() => c.promise} /></LazyWidgetSlot>
        <LazyWidgetSlot id="e" priority={2} minHeight={10}><QueryWidget label="e" fetcher={() => Promise.resolve('e-data')} /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    // c takes a's lane at once. a's unmount cleared its fallback timer, so
    // nothing else would ever have freed that lane.
    expect(await screen.findByText('c-loading', undefined, BEFORE_FALLBACK)).toBeDefined();

    // When c settles, the lane goes to e, not to the unmounted b, whose
    // priority 1 would otherwise win it and pin it forever.
    await act(async () => { c.resolve('c-data'); await Promise.resolve(); });
    expect(await screen.findByText('e-data', undefined, BEFORE_FALLBACK)).toBeDefined();
    expect(document.querySelector('[data-widget-state="deferred"]')).toBeNull();
  });

  it('holds the lane until EVERY query in the widget has settled, not just the first', async () => {
    // Most widgets pair their real query with a Compare query that resolves
    // null at once while Compare is off. That instant query must not free the
    // lane while the real one is still running.
    const main = deferred<string>();
    function TwoQueryWidget(): React.JSX.Element {
      const compare = useQuery(() => Promise.resolve(null), []);
      const q = useQuery(() => main.promise, []);
      return (
        <>
          <span>{compare.status === 'success' ? 'compare-done' : 'compare-loading'}</span>
          <span>{q.status === 'success' ? q.data : 'a-loading'}</span>
        </>
      );
    }
    render(
      <WidgetSchedulerProvider maxConcurrent={1}>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><TwoQueryWidget /></LazyWidgetSlot>
        <LazyWidgetSlot id="b" priority={1} minHeight={10}><Child label="b" /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    expect(await screen.findByText('compare-done')).toBeDefined();
    await settle();
    expect(screen.getByText('a-loading')).toBeDefined();
    expect(screen.queryByText('b')).toBeNull();

    await act(async () => { main.resolve('a-data'); await Promise.resolve(); });
    expect(await screen.findByText('b', undefined, BEFORE_FALLBACK)).toBeDefined();
  });

  it('keeps the lane while a query restarts mid-flight', async () => {
    // A deps change (or a cancel-retry) abandons the running query and starts
    // its replacement in the same effect flush. The momentary zero in-flight
    // count between the two must not free the lane.
    const user = userEvent.setup();
    function RestartingWidget(): React.JSX.Element {
      const [n, setN] = useState(0);
      const q = useQuery(hang, [n]);
      return <button type="button" onClick={() => { setN(v => v + 1); }}>{`a-${q.status}-${String(n)}`}</button>;
    }
    render(
      <WidgetSchedulerProvider maxConcurrent={1}>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><RestartingWidget /></LazyWidgetSlot>
        <LazyWidgetSlot id="b" priority={1} minHeight={10}><Child label="b" /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    await user.click(await screen.findByText('a-loading-0'));
    expect(await screen.findByText('a-loading-1')).toBeDefined();
    await settle();
    expect(screen.queryByText('b')).toBeNull();
  });

  it('neither leaks nor frees a lane early under StrictMode', async () => {
    // The app renders under StrictMode: each slot requests, releases and
    // re-requests its ticket, and each query tracks, untracks and re-tracks.
    const a = deferred<string>();
    render(
      <StrictMode>
        <WidgetSchedulerProvider maxConcurrent={1}>
          <LazyWidgetSlot id="a" priority={0} minHeight={10}><QueryWidget label="a" fetcher={() => a.promise} /></LazyWidgetSlot>
          <LazyWidgetSlot id="b" priority={1} minHeight={10}><QueryWidget label="b" fetcher={() => Promise.resolve('b-data')} /></LazyWidgetSlot>
        </WidgetSchedulerProvider>
      </StrictMode>,
    );
    expect(await screen.findByText('a-loading')).toBeDefined();
    await settle();
    expect(screen.queryByText('b-loading')).toBeNull();
    expect(screen.queryByText('b-data')).toBeNull();

    await act(async () => { a.resolve('a-data'); await Promise.resolve(); });
    expect(await screen.findByText('b-data', undefined, BEFORE_FALLBACK)).toBeDefined();
  });

  it('a grant does not re-render the widgets already mounted', async () => {
    const user = userEvent.setup();
    const renders = new Map<string, number>();
    const counter = (label: string) => () => { renders.set(label, (renders.get(label) ?? 0) + 1); };
    render(
      <WidgetSchedulerProvider maxConcurrent={2}>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><Child label="a" onRender={counter('a')} /></LazyWidgetSlot>
        <LazyWidgetSlot id="b" priority={1} minHeight={10}><Child label="b" onRender={counter('b')} /></LazyWidgetSlot>
        <LazyWidgetSlot id="c" priority={2} minHeight={10}><Child label="c" onRender={counter('c')} /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );
    expect(await screen.findByText('a')).toBeDefined();
    expect(await screen.findByText('b')).toBeDefined();
    await settle();
    const before = { a: renders.get('a'), b: renders.get('b') };

    // a settles → c is granted a's lane. Neither a nor b has anything to redo.
    await user.click(screen.getByText('a'));
    expect(await screen.findByText('c')).toBeDefined();
    await settle();
    expect({ a: renders.get('a'), b: renders.get('b') }).toEqual(before);
  });

  it("a grant does not restart the other mounted widgets' fallback timers", async () => {
    vi.useFakeTimers();
    try {
      render(
        <WidgetSchedulerProvider maxConcurrent={2}>
          <LazyWidgetSlot id="a" priority={0} minHeight={10}><Child label="a" /></LazyWidgetSlot>
          <LazyWidgetSlot id="b" priority={1} minHeight={10}><Child label="b" /></LazyWidgetSlot>
          <LazyWidgetSlot id="c" priority={2} minHeight={10}><Child label="c" /></LazyWidgetSlot>
          <LazyWidgetSlot id="d" priority={3} minHeight={10}><Child label="d" /></LazyWidgetSlot>
        </WidgetSchedulerProvider>,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByText('a')).not.toBeNull();
      expect(screen.queryByText('b')).not.toBeNull();

      // t=4s: b settles and c is granted its lane; a is still hanging.
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      await act(async () => { fireEvent.click(screen.getByText('b')); await Promise.resolve(); });
      expect(screen.queryByText('c')).not.toBeNull();
      expect(screen.queryByText('d')).toBeNull();

      // t=5.1s: a's fallback, armed when a mounted, has freed its lane for d.
      // c's grant must not have re-armed it (which would hold d until t=9s).
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(screen.queryByText('d')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores non-intersecting entries', () => {
    setAutoIntersect(false);
    render(
      <WidgetSchedulerProvider maxConcurrent={2}>
        <LazyWidgetSlot id="a" priority={0} minHeight={10}><Child label="a" /></LazyWidgetSlot>
      </WidgetSchedulerProvider>,
    );

    // An entry that reports the slot still off-screen must not mount it.
    act(() => { fireIntersections(false); });
    expect(screen.queryByText('a')).toBeNull();
  });
});
