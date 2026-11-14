import type { FunctionComponent } from 'react';

/**
 * Counts the renders of `memo` components, for the suites that assert a
 * component bailed out: the DOM can't tell a bail-out from a render that
 * produced the same output.
 *
 * A suite mocks `react` with the spied module, then reads the counts:
 *
 *   vi.mock('react', async (importOriginal) =>
 *     (await import('./memo-renders.js')).withMemoSpy(await importOriginal<typeof import('react')>()));
 *   beforeEach(() => { takeMemoRenders(); });
 */

/** Every render of a spied component, by the name of the function handed to
 *  `memo`, in order. A memo that bails out leaves no entry. */
const renders: string[] = [];

/** `react`, with a `memo` that records each render of the function components
 *  it wraps. */
export function withMemoSpy(actual: typeof import('react')): Readonly<Record<string, unknown>> {
  function memo<P extends object>(component: FunctionComponent<P>, propsAreEqual?: (prev: Readonly<P>, next: Readonly<P>) => boolean) {
    // `memo` also takes forwardRef and other exotic components, which are
    // objects, not functions to call: those are left as they are.
    if (typeof component !== 'function') return actual.memo(component, propsAreEqual);
    const spied: FunctionComponent<P> = (props) => {
      renders.push(component.name);
      return component(props);
    };
    spied.displayName = component.displayName ?? component.name;
    return actual.memo(spied, propsAreEqual);
  }
  return { ...actual, memo };
}

/** How many times each of the named components rendered since the last call
 *  (or the first spied render). Forgets every render recorded so far, the
 *  other components' too. */
export function takeMemoRenders(...names: readonly string[]): Readonly<Record<string, number>> {
  const taken = renders.splice(0);
  return Object.fromEntries(names.map(name => [name, taken.filter(rendered => rendered === name).length]));
}
