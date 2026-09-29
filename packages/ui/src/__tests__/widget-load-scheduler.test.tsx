import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LazyWidgetSlot, WidgetSchedulerProvider, useWidgetSlot } from '../hooks/widget-load-scheduler.js';
import { useQuery } from '../hooks/use-query.js';
import { fireIntersections, setAutoIntersect } from './setup.js';

// A test widget that renders its label once mounted and frees its scheduler
// slot when clicked (standing in for "its query settled").
function Child({ label }: Readonly<{ label: string }>): React.JSX.Element {
  const slot = useWidgetSlot();
  return <button type="button" onClick={() => { slot?.onSettled(); }}>{label}</button>;
}

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
