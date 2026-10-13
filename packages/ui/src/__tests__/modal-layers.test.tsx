import { act, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  ModalLayer,
  getModalLayerCount,
  getOpenModalLayerKinds,
  isAnotherModalLayerOpen,
  useModalLayerCount,
  useRegisterModalLayer,
} from '../hooks/modal-layers.js';
import type { ModalLayerHandle } from '../hooks/modal-layers.js';

/** Renders the live layer count, the way a consumer (the update auto-open, the
 *  palette gate) reads it. */
function CountProbe(): React.JSX.Element {
  return <output data-testid="count">{useModalLayerCount()}</output>;
}

function count(): string | null {
  return screen.getByTestId('count').textContent;
}

describe('modal layer registry', () => {
  it('counts each mounted layer and forgets it on unmount, without a provider', () => {
    const { rerender } = render(<CountProbe />);
    expect(count()).toBe('0');

    rerender(<><CountProbe /><ModalLayer kind="dialog" /></>);
    expect(count()).toBe('1');
    expect(getModalLayerCount()).toBe(1);

    rerender(<><CountProbe /><ModalLayer kind="dialog" /><ModalLayer kind="palette" /></>);
    expect(count()).toBe('2');
    expect(getOpenModalLayerKinds()).toEqual(['dialog', 'palette']);

    rerender(<CountProbe />);
    expect(count()).toBe('0');
    expect(getOpenModalLayerKinds()).toEqual([]);
  });

  it('registers only while active', () => {
    function Toggle({ active }: Readonly<{ active: boolean }>): null {
      useRegisterModalLayer(active, 'palette');
      return null;
    }
    const { rerender } = render(<><CountProbe /><Toggle active={false} /></>);
    expect(count()).toBe('0');
    rerender(<><CountProbe /><Toggle active /></>);
    expect(count()).toBe('1');
    rerender(<><CountProbe /><Toggle active={false} /></>);
    expect(count()).toBe('0');
  });

  // StrictMode mounts, unmounts and remounts every effect: a registration that
  // was not idempotent would leave the count at 2 (or 0) for a single layer.
  it('counts a layer once under StrictMode', () => {
    render(<StrictMode><CountProbe /><ModalLayer kind="modal-shell" /></StrictMode>);
    expect(count()).toBe('1');
  });

  // The palette registers itself while open. Its Cmd+K gate must refuse to
  // open over another layer, yet still let Cmd+K close it while it is the
  // only one — so the question excludes the asking layer.
  it('answers "is another layer open" excluding the asking layer', () => {
    let palette: ModalLayerHandle | null = null;
    function Palette({ open }: Readonly<{ open: boolean }>): null {
      palette = useRegisterModalLayer(open, 'palette');
      return null;
    }
    const { rerender } = render(<Palette open={false} />);
    expect(isAnotherModalLayerOpen(palette)).toBe(false);

    rerender(<Palette open />);
    expect(getModalLayerCount()).toBe(1);
    expect(isAnotherModalLayerOpen(palette)).toBe(false);
    // Without a handle, every open layer counts.
    expect(isAnotherModalLayerOpen()).toBe(true);

    rerender(<><Palette open /><ModalLayer kind="dialog" /></>);
    expect(isAnotherModalLayerOpen(palette)).toBe(true);
  });

  it('keeps the same handle across re-renders', () => {
    const handles = new Set<ModalLayerHandle>();
    function Layer(): React.JSX.Element {
      const [, setTick] = useState(0);
      handles.add(useRegisterModalLayer(true, 'dialog'));
      return <button type="button" onClick={() => { setTick((t) => t + 1); }}>tick</button>;
    }
    render(<Layer />);
    act(() => { screen.getByRole('button', { name: 'tick' }).click(); });
    expect(handles.size).toBe(1);
    expect(getModalLayerCount()).toBe(1);
  });
});
