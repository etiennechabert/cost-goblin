import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../components/command-palette.js';
import { ModalLayer, getModalLayerCount, getOpenModalLayerKinds } from '../hooks/modal-layers.js';
import { appRegionOf } from './app-region.js';

const items = [
  { id: 'overview', label: 'Overview' },
  { id: 'explorer', label: 'Explorer' },
];

const PLACEHOLDER = 'Type to search...';

function paletteInput(): HTMLElement | null {
  return screen.queryByPlaceholderText(PLACEHOLDER);
}

describe('CommandPalette', () => {
  it('opts the overlay and content out of window drag regions', async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={items} onNavigate={vi.fn()} />);
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByPlaceholderText(PLACEHOLDER);

    // The overlay covers the frameless window's drag region (app header), so
    // both layers must carve themselves out — otherwise clicks in the top
    // band drag the window instead of dismissing the palette.
    const overlay = document.querySelector('[cmdk-overlay]');
    if (overlay === null) throw new Error('overlay not found');
    expect(appRegionOf(overlay)).toBe('no-drag');
    const content = document.querySelector('[cmdk-dialog]');
    if (content === null) throw new Error('content not found');
    expect(appRegionOf(content)).toBe('no-drag');
  });

  it('counts as a modal layer while open, and Cmd+K closes it again', async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={items} onNavigate={vi.fn()} />);
    expect(getModalLayerCount()).toBe(0);

    await user.keyboard('{Meta>}k{/Meta}');
    expect(paletteInput()).not.toBeNull();
    expect(getOpenModalLayerKinds()).toEqual(['palette']);

    // Its own layer must not count against it: Cmd+K toggles it shut.
    await user.keyboard('{Meta>}k{/Meta}');
    expect(paletteInput()).toBeNull();
    expect(getModalLayerCount()).toBe(0);
  });

  // Opening over a modal stacks a second modal system on the first: navigating
  // from the palette (e.g. "Switch workspace") then mounts a confirm dialog
  // under the other modal's pointer lock, and its buttons stop working.
  it('does not open while another modal layer is open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <><CommandPalette items={items} onNavigate={vi.fn()} /><ModalLayer kind="dialog" /></>,
    );
    await user.keyboard('{Meta>}k{/Meta}');
    expect(paletteInput()).toBeNull();
    expect(getOpenModalLayerKinds()).toEqual(['dialog']);

    // …and opens again once that layer is gone.
    rerender(<CommandPalette items={items} onNavigate={vi.fn()} />);
    await user.keyboard('{Meta>}k{/Meta}');
    expect(paletteInput()).not.toBeNull();
  });

  // The palette has no Radix Trigger, so Radix's own restore drops focus to
  // <body> on close.
  it('returns focus to the element focused before it opened', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Opener</button>
        <CommandPalette items={items} onNavigate={vi.fn()} />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(document.activeElement).toBe(paletteInput());

    await user.keyboard('{Escape}');
    expect(paletteInput()).toBeNull();
    await waitFor(() => { expect(document.activeElement).toBe(opener); });
  });

  // A navigation can open a page or a dialog that takes focus itself (a
  // confirm focuses its Cancel on mount); the restore must not pull focus back
  // behind it.
  it('leaves focus where a navigation moved it', async () => {
    const user = userEvent.setup();
    function Destination(): React.JSX.Element {
      const ref = useRef<HTMLInputElement>(null);
      useEffect(() => { ref.current?.focus(); }, []);
      return <input ref={ref} aria-label="Destination" />;
    }
    function Page(): React.JSX.Element {
      const [navigated, setNavigated] = useState(false);
      return (
        <>
          <button type="button">Opener</button>
          {navigated && <Destination />}
          <CommandPalette items={items} onNavigate={() => { setNavigated(true); }} />
        </>
      );
    }
    render(<Page />);
    screen.getByRole('button', { name: 'Opener' }).focus();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('{Enter}');
    expect(paletteInput()).toBeNull();
    const destination = screen.getByRole('textbox', { name: 'Destination' });
    // Let the palette's close-time focus handling run before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(document.activeElement).toBe(destination);
  });
});
